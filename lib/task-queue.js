/** 全局任务队列（任务级信号量）：抓取/日报/专题按「任务」排队——上限=llmConcurrency 设置。
 *  在跑任务数 < 上限时新任务立即开跑；满了进 FIFO 等待队列，有空位按序接棒。
 *  同类任务互斥（fetch/digest/topic 各最多一个在跑）——保留原 busy 锁语义。
 *  调用级 LLM 信号量在 dsh-llm.ts 继续兜底（限住单任务内部并行+真实并发上限）。 */
export function createTaskQueue(opts) {
    const waiting = [];
    const running = new Map();
    const limit = () => Math.max(1, Math.min(8, Math.floor(opts.limit() || 1)));
    const pump = () => {
        const kinds = new Set([...running.values()].map((t) => t.kind));
        while (waiting.length && running.size < limit()) {
            // canStart=高峰挂起谓词：held 任务留在队列不占位（后面的可启动任务照常接棒——非严格 FIFO）
            const i = waiting.findIndex((t) => !kinds.has(t.kind) && (opts.canStart?.(t) ?? true));
            if (i < 0)
                break; // 有空位但等待者全是在跑同类/全部被挂起——等它们自己的接棒
            const t = waiting.splice(i, 1)[0];
            kinds.add(t.kind);
            running.set(t.id, t);
            // setImmediate 排水：任务启动推迟到 check 阶段——poll 阶段先到一步的 HTTP 请求先被服务；
            // 若走 microtask，任务同步前缀（如专题候选查询）会把门口请求堵住数秒（表现为页面白屏转圈）
            new Promise((res) => setImmediate(res))
                .then(() => t.start())
                .then((v) => t.settle?.resolve(v))
                .catch((e) => { t.settle?.reject(e); opts.log?.warn(`task ${t.id} failed: ${e instanceof Error ? e.message : String(e)}`); })
                .finally(() => { running.delete(t.id); pump(); });
        }
    };
    return {
        /** 入队+立即尝试排水；返回 started（抢到位直接跑）/ queued（排队）/ dup（同 id 已在跑或在排——合并） */
        enqueue(t) {
            if (running.has(t.id) || waiting.some((x) => x.id === t.id))
                return 'dup';
            waiting.push(t);
            pump();
            return running.has(t.id) ? 'started' : 'queued';
        },
        /** 取消：waiting→撤队（onCancelQueued 副作用 + settle 兑现 cancelled）;running→cancel() 钩子；都没中→'none' */
        cancel(id) {
            const wi = waiting.findIndex((t) => t.id === id);
            if (wi >= 0) {
                const t = waiting.splice(wi, 1)[0];
                t.onCancelQueued?.();
                t.settle?.resolve({ cancelled: 'waiting' });
                return 'waiting';
            }
            const r = running.get(id);
            if (r) {
                r.cancel?.();
                return 'running';
            }
            return 'none';
        },
        /** 只摘 waiting 不调副作用（删除接口用——meta 由删除方处理） */
        removeQueued(id) {
            const i = waiting.findIndex((t) => t.id === id);
            if (i >= 0) {
                waiting.splice(i, 1);
                return true;
            }
            return false;
        },
        has: (id) => running.has(id) || waiting.some((t) => t.id === id),
        isQueued: (id) => waiting.some((t) => t.id === id),
        isRunning: (id) => running.has(id),
        isKindRunning: (kind) => [...running.values()].some((t) => t.kind === kind),
        waitingList: () => [...waiting],
        runningList: () => [...running.values()],
        waitingIds: (kind) => waiting.filter((t) => !kind || t.kind === kind).map((t) => t.id),
        waitingCount: () => waiting.length,
        limit,
        pump,
    };
}
//# sourceMappingURL=task-queue.js.map