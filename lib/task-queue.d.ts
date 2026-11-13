/** 全局任务队列（任务级信号量）：抓取/日报/专题按「任务」排队——上限=llmConcurrency 设置。
 *  在跑任务数 < 上限时新任务立即开跑；满了进 FIFO 等待队列，有空位按序接棒。
 *  同类任务互斥（fetch/digest/topic 各最多一个在跑）——保留原 busy 锁语义。
 *  调用级 LLM 信号量在 dsh-llm.ts 继续兜底（限住单任务内部并行+真实并发上限）。 */
export interface GTask {
    /** 唯一任务键：'fetch' | 'digest' | `topic:${metaId}` —— 同 id 重复入队直接合并（dup） */
    id: string;
    kind: 'fetch' | 'digest' | 'topic';
    /** 悬停任务列表显示名 */
    label: string;
    queuedAt: number;
    /** 真正开跑的入口；返回值作为 settle 的结果（可选） */
    start: () => Promise<unknown> | unknown;
    /** running 态取消钩子（各管线 abort）；waiting 态撤队走 onCancelQueued */
    cancel?: () => void;
    /** waiting 态被撤的副作用（如专题 meta 落 error） */
    onCancelQueued?: () => void;
    /** 有调用方等结果时挂这里——任务真正跑完后兑现（无论等了多久） */
    settle?: {
        resolve: (v: unknown) => void;
        reject: (e: unknown) => void;
    };
}
export type EnqueueResult = 'started' | 'queued' | 'dup';
export declare function createTaskQueue(opts: {
    limit: () => number;
    log?: {
        warn: (s: string) => void;
    };
}): {
    /** 入队+立即尝试排水；返回 started（抢到位直接跑）/ queued（排队）/ dup（同 id 已在跑或在排——合并） */
    enqueue(t: GTask): EnqueueResult;
    /** 取消：waiting→撤队（onCancelQueued 副作用 + settle 兑现 cancelled）;running→cancel() 钩子；都没中→'none' */
    cancel(id: string): "waiting" | "running" | "none";
    /** 只摘 waiting 不调副作用（删除接口用——meta 由删除方处理） */
    removeQueued(id: string): boolean;
    has: (id: string) => boolean;
    isQueued: (id: string) => boolean;
    isRunning: (id: string) => boolean;
    isKindRunning: (kind: GTask["kind"]) => boolean;
    waitingList: () => GTask[];
    runningList: () => GTask[];
    waitingIds: (kind?: GTask["kind"]) => string[];
    waitingCount: () => number;
    limit: () => number;
    pump: () => void;
};
export type TaskQueue = ReturnType<typeof createTaskQueue>;
//# sourceMappingURL=task-queue.d.ts.map