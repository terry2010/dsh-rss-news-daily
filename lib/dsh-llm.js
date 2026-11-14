/**
 * Adapter that routes summarization through the host's `ctx.llm` service.
 *
 * Provider/model resolution is deferred to the first call so that HMR or late
 * registrations (e.g. the DeepSeek adapter activating after startup) are
 * honored. When no adapter is registered yet the call fails loudly and the
 * summarizer degrades to its extractive fallback.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
class RssServiceError extends Error {
}
/** Pick a live provider/model pair honoring configured values. */
export async function resolveDshRoute(llm, route) {
    // 成对校验：只填一个视为都未配置（走宿主默认路由，不猜半个配置）
    let provider = route.provider;
    let model = route.model;
    if (provider === '' || model === '') {
        provider = '';
        model = '';
    }
    if (provider === '') {
        const providers = llm.listProviders();
        const first = providers[0];
        if (first === undefined) {
            throw new RssServiceError('no LLM provider is registered in this dsh instance');
        }
        provider = (providers.find((entry) => /deepseek|official/i.test(entry.id)) ?? first).id;
    }
    if (model === '') {
        const models = await llm.listModels(provider).catch(() => []);
        const first = models[0];
        if (first !== undefined) {
            model = (models.find((entry) => /chat|flash|deepseek|v3|r1|pro/i.test(entry.id)) ?? first).id;
        }
    }
    if (model === '') {
        throw new RssServiceError(`provider ${provider} lists no model; configure summary.model`);
    }
    return { provider, model };
}
let rawUsageLogged = false; // 一次性探针标记
/** LLM 诊断日志文件（ctx.logger 不落盘——模型死循环排查需要可查的文本证据）。 */
let diagFile;
export function setLlmDiagFile(path) { diagFile = path; }
function diagLog(line) {
    if (!diagFile)
        return;
    void appendFile(diagFile, `${localIso(new Date())} ${line}\n`).catch(() => { });
}
/** 开发日志（prefs.devLog 开关）：完整 prompt/response + token/速度，按天 JSONL 落 devlog/。 */
let devLogDir;
let devLogEnabled = () => false;
export function setDevLogDir(dir) { devLogDir = dir; }
export function setDevLogEnabled(fn) { devLogEnabled = fn; }
let devLogDirReady;
function devLogRecord(rec) {
    if (!devLogDir || !devLogEnabled())
        return;
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const file = join(devLogDir, `dev-${day}.jsonl`);
    devLogDirReady ??= mkdir(devLogDir, { recursive: true }).catch(() => { });
    void devLogDirReady.then(() => appendFile(file, JSON.stringify(rec) + '\n').catch(() => { }));
}
const FIELD_CAP = 256 * 1024; // 单字段上限：新闻 prompt 正常 <10KB，防异常大输出撑爆日志
const capField = (s) => s === undefined ? undefined : (s.length > FIELD_CAP ? s.slice(0, FIELD_CAP) + '…[truncated]' : s);
/** 本地时区 ISO 时间（含偏移）：2026-11-08T17:32:36.091+08:00——比 UTC 直观且仍可排序 */
const localIso = (d) => {
    const p = (n, l = 2) => String(n).padStart(l, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
};
let loopDetLoad;
let loopDetResolve = null;
let loopDetState = 'untested';
let loopGuardOn = () => true; // 默认开；装了 loop-recover 才真生效
export function setLoopGuardEnabled(fn) { loopGuardOn = fn; }
/** 检测器实际状态：供 /api/loopguard 告诉用户"装了但没启用/根本没装" */
export function loopDetectStatus() { return loopDetState; }
function loadLoopDetect(log) {
    loopDetLoad ??= (async () => {
        try {
            const spec = 'dsh-loop-recover/detector';
            const m = await import(spec);
            if (typeof m.detectRepetition !== 'function') {
                loopDetState = 'absent';
                return null;
            }
            loopDetResolve = typeof m.resolveDetectorOptions === 'function' ? m.resolveDetectorOptions : null;
            loopDetState = 'active';
            log.info('loop-recover detector loaded: stream loop filter enabled');
            return m.detectRepetition;
        }
        catch {
            loopDetState = 'absent';
            return null;
        }
    })();
    return loopDetLoad;
}
/** 推理通道放宽的检测参数：逐条枚举分析时"该条相关/需要引用"这类模板判语会命中 pool——
 *  那是模型的正常文风不是死循环；周期/锚段/单字符层维持默认（真复读仍拦得住）。 */
const REASONING_GUARD_OPTS = { poolMinRepeats: 8, ngramRepeats: 4 };
/** Accumulate a stream into plain text, surfacing terminal failures. usage 传入对象则原地累计 token 用量（流中 usage 为累计值，取最新）。loopDetect 命中即截流。 */
export async function collectText(stream, usage, diag, loopDetect) {
    let text = '';
    let reasoningBuf = ''; // 检测窗口：reasoning 死循环也只能靠它现形（截尾 8K 防全量重扫）
    let lastTextCheck = 0;
    let lastReasoningCheck = 0;
    let firstAt = 0; // 首个 chunk 到达时刻：genMs = 纯生成耗时（不含路由解析/建流）
    try {
        for await (const chunk of stream) {
            if (!firstAt)
                firstAt = Date.now();
            const u = chunk.usage;
            if (u && !rawUsageLogged) {
                rawUsageLogged = true;
                diagLog(`RAW usage ${JSON.stringify(u)}`);
            } // 探针：确认宿主透传了哪些 usage 字段
            const uc = u?.cacheReadTokens;
            if (usage && u) {
                if (typeof u.inputTokens === 'number')
                    usage.inputTokens += u.inputTokens - (usage._seen ?? 0); // 累计值取增量
                if (typeof u.outputTokens === 'number')
                    usage.outputTokens += u.outputTokens - (usage._seenOut ?? 0);
                if (typeof uc === 'number')
                    usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + uc - (usage._seenCache ?? 0);
                if (typeof u.inputTokens === 'number')
                    usage._seen = u.inputTokens;
                if (typeof u.outputTokens === 'number')
                    usage._seenOut = u.outputTokens;
                if (typeof uc === 'number')
                    usage._seenCache = uc;
            }
            switch (chunk.type) {
                case 'text-delta':
                    text += chunk.text;
                    if (loopDetect && text.length - lastTextCheck >= 2048) {
                        lastTextCheck = text.length;
                        const hit = loopDetect(text);
                        if (hit) {
                            if (diag)
                                diag.loop = `${hit.kind ?? 'repetition'}@${hit.cutStart ?? text.length}`;
                            return text.slice(0, hit.cutStart ?? text.length); // for-await 退出即关闭底层流
                        }
                    }
                    break;
                case 'reasoning-delta':
                    // Reasoning deltas are not part of the visible answer — 但留证供死循环诊断
                    if (diag) {
                        diag.reasoningChars += chunk.text.length;
                        diag.tail = (diag.tail + chunk.text).slice(-1200); // 留足尾巴：既是诊断证据，也是循环截流后"带上下文续写"的素材
                    }
                    if (loopDetect) {
                        reasoningBuf = (reasoningBuf + chunk.text).slice(-8192);
                        const totalR = diag?.reasoningChars ?? reasoningBuf.length; // 增量按总量计：buffer 有上限，到顶后 length 不再涨
                        if (reasoningBuf.length >= 2048 && totalR - lastReasoningCheck >= 2048) {
                            lastReasoningCheck = totalR;
                            // 推理流放宽阈值：逐条分析时同一句收尾判语是正常文风而非死循环（pool 4→8、ngram 3→4）；text 通道维持严格默认
                            // opts 必须经 resolveDetectorOptions 合并成完整配置——裸传 partial 会让检测器内部字段全 undefined 形同禁用
                            const hit = loopDetect(reasoningBuf, loopDetResolve?.(REASONING_GUARD_OPTS));
                            if (hit)
                                throw new RssServiceError(`LLM reasoning loop detected: ${hit.kind ?? '?'} — ${hit.detail ?? ''}; ev="${(hit.evidence ?? '').slice(0, 80).replace(/\s+/g, ' ')}" (reasoning ${totalR} chars)`);
                        }
                    }
                    break;
                case 'finish':
                    if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
                        throw new RssServiceError(`LLM call failed: ${chunk.reason.kind}: ${chunk.reason.failure.message} (${chunk.reason.failure.code})`);
                    }
                    break;
                default:
                    break;
            }
        }
    }
    catch (e) {
        if (diag) {
            diag.partial = text;
            diag.genMs = firstAt ? Date.now() - firstAt : 0;
        }
        throw e;
    }
    if (diag)
        diag.genMs = firstAt ? Date.now() - firstAt : 0;
    if (text.trim() === '') {
        const d = diag ? ` (reasoning ${diag.reasoningChars} chars${diag.tail ? `, tail: "${diag.tail.slice(-160).replace(/\s+/g, ' ')}"` : ''})` : '';
        throw new RssServiceError(`LLM returned an empty completion${d}`);
    }
    return text;
}
// ---- 全局 LLM 并发信号量 ----
// 所有 generateText 调用收口排队：日报/快报/翻译/评分/判定/专题共用一条模型通道。
// 上限经 getter 实时读取（改设置即生效）；超额调用 FIFO 排队，等待期 signal 可中断不占槽。
let llmSlots = 0;
const llmQueue = [];
const llmRunning = [];
const llmRunByTag = new Map();
let llmConcurrencyFn = () => 1;
export function setLlmConcurrency(fn) { llmConcurrencyFn = fn; }
const llmLimit = () => Math.max(1, Math.min(8, Math.floor(llmConcurrencyFn() || 1)));
// abort 冷却：在飞 fetch 被中止后 undici 拆除 socket 是异步竞态——立刻向同一 origin 连接池
// 发新请求，writeH1 会把写排进垂死 socket（setTypeOfService EINVAL 直接崩宿主进程）。
// 中止时刻打点，冷却期内拿槽「先同步占槽、延后兑现」：HTTP 推迟到 socket 拆完，计数语义不变。
let lastLlmAbortAt = 0;
const LLM_ABORT_COOLDOWN_MS = 250;
const llmAbortCooldownLeft = () => Math.max(0, LLM_ABORT_COOLDOWN_MS - (Date.now() - lastLlmAbortAt));
const noteLlmAbort = () => { lastLlmAbortAt = Date.now(); };
const bumpRunTag = (tag, d) => {
    const n = (llmRunByTag.get(tag) ?? 0) + d;
    if (n <= 0)
        llmRunByTag.delete(tag);
    else
        llmRunByTag.set(tag, n);
};
function releaseLlmSlot() {
    llmSlots = Math.max(0, llmSlots - 1);
    llmQueue.shift()?.wake(); // 有等待者唤醒一个（其内部自增槽位）
}
function acquireLlmSlot(signal, tag, purpose) {
    const grant = () => {
        llmSlots++;
        const runEntry = { tag, purpose };
        llmRunning.push(runEntry);
        bumpRunTag(tag, 1);
        return () => {
            const i = llmRunning.indexOf(runEntry);
            if (i >= 0)
                llmRunning.splice(i, 1);
            bumpRunTag(tag, -1);
            releaseLlmSlot();
        };
    };
    // 槽位已同步预留，兑现按冷却延后；冷却期 signal 中止→释放预留槽并 reject（不白占坑）
    const deferred = (release) => {
        const wait = llmAbortCooldownLeft();
        if (signal?.aborted) {
            release();
            return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        }
        if (wait <= 0)
            return Promise.resolve(release);
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(release); }, wait);
            const onAbort = () => { clearTimeout(t); release(); reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted')); };
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    };
    if (llmSlots < llmLimit())
        return deferred(grant());
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            return;
        } // 预检后到入队前的 abort 窗口：已终止的 signal 不会再派发 abort 事件
        let done = false;
        const entry = {
            tag, purpose,
            wake: () => {
                if (done)
                    return;
                done = true;
                signal?.removeEventListener('abort', onAbort);
                resolve(deferred(grant()));
            },
        };
        const onAbort = () => {
            if (done)
                return;
            done = true;
            const i = llmQueue.indexOf(entry);
            if (i >= 0)
                llmQueue.splice(i, 1); // 仍在排队：撤出不占槽
            reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
        };
        llmQueue.push(entry);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
/** LLM 队列快照：tagSet 圈定「本任务」客户端 tag 集合，进度端据此区分「在执行」与「排队等锁」。
 * tagAhead = 排在本任务首个排队调用之前的调用数 + 正占着槽位的他人调用数（并发=1 时即"还要等几个调用完成"） */
export function llmQueueSnapshot(tagSet) {
    let tagRunning = 0;
    if (tagSet)
        for (const t of tagSet)
            tagRunning += llmRunByTag.get(t) ?? 0;
    const inSet = (t) => !!tagSet && tagSet.includes(t);
    const tagQueued = tagSet ? llmQueue.reduce((n, e) => n + (inSet(e.tag) ? 1 : 0), 0) : 0;
    const firstIdx = tagSet ? llmQueue.findIndex((e) => inSet(e.tag)) : -1;
    const tagAhead = firstIdx >= 0 ? firstIdx + Math.max(0, llmSlots - tagRunning) : 0;
    const purposeOf = (e) => e.purpose ?? e.tag;
    return {
        limit: llmLimit(), running: llmSlots, queued: llmQueue.length, tagRunning, tagQueued, tagAhead,
        mineQueued: llmQueue.filter((e) => inSet(e.tag)).map(purposeOf),
        ahead: [
            ...llmRunning.filter((e) => !inSet(e.tag)).map(purposeOf),
            ...(firstIdx >= 0 ? llmQueue.slice(0, firstIdx).map(purposeOf) : []),
        ],
    };
}
const llmDurEma = new Map();
let llmDurGlobal;
let durPersist = null;
const LLM_EMA_A = 0.4;
/** 某类调用的滑动平均耗时 ms；该桶无样本退全局均值，再无样本 undefined（前端据此显示「估算中」） */
export function llmCallAvgMs(purpose) {
    if (purpose) {
        const v = llmDurEma.get(purpose);
        if (v != null)
            return v;
    }
    return llmDurGlobal;
}
export function setLlmDurPersistence(p) { durPersist = p; }
/** 灌回持久化的 EMA——插件启动 store.load() 完成后调用 */
export function setLlmDurState(s) {
    if (!s)
        return;
    if (typeof s.global === 'number' && Number.isFinite(s.global) && s.global > 0)
        llmDurGlobal = s.global;
    for (const [k, v] of Object.entries(s.byPurpose ?? {})) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0)
            llmDurEma.set(k, v);
    }
}
function recordLlmMs(purpose, ms) {
    llmDurGlobal = llmDurGlobal == null ? ms : llmDurGlobal * (1 - LLM_EMA_A) + ms * LLM_EMA_A;
    if (purpose)
        llmDurEma.set(purpose, llmDurEma.has(purpose) ? llmDurEma.get(purpose) * (1 - LLM_EMA_A) + ms * LLM_EMA_A : ms);
    durPersist?.save?.({ global: llmDurGlobal, byPurpose: Object.fromEntries(llmDurEma) }); // 写 meta 内存对象；落盘随下一次 store.save()
}
/** {@link LlmClient} backed by the harness `ctx.llm` streaming service. */
export class DshLlmClient {
    llm;
    route;
    log;
    idleTimeoutMs;
    tag;
    resolution;
    /** 本 client 生命周期内的累计 token 用量（pipeline 每次 digest 新建实例 → 即单次日报用量） */
    usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    constructor(llm, route, log, tag = 'llm', idleTimeoutMs = LLM_IDLE_MS) {
        this.llm = llm;
        this.route = route;
        this.log = log;
        this.idleTimeoutMs = idleTimeoutMs;
        this.tag = tag;
    }
    async generateText(request) {
        if (request.signal?.aborted)
            throw request.signal.reason instanceof Error ? request.signal.reason : new Error('aborted');
        // 全局并发锁：槽位持有覆盖 system 折叠重试（同属一次逻辑调用）
        const t0 = Date.now();
        const release = await acquireLlmSlot(request.signal, this.tag, request.purpose);
        try {
            let text;
            try {
                text = await this.call(request);
            }
            catch (error) {
                // 部分本地模型（translategemma 等）chat template 不支持 system 首条——
                // 把 system 折进 user prompt 重试一次，而不是整条翻译链失败
                const reason = error instanceof Error ? error.message : String(error);
                if (request.system !== undefined && /chat template|must start with a user/i.test(reason)) {
                    this.log.warn(`LLM rejected system prompt, retrying folded into user message: ${reason.slice(0, 140)}`);
                    text = await this.call({ ...request, system: undefined, prompt: `${request.system}\n\n${request.prompt}` });
                }
                else {
                    throw error;
                }
            }
            recordLlmMs(request.purpose, Date.now() - t0); // 仅成功入表：失败/中止的截断耗时不污染均值
            return text;
        }
        finally {
            release();
        }
    }
    async call(request) {
        let route;
        try {
            route = this.resolution ??= await resolveDshRoute(this.llm, this.route);
        }
        catch (e) {
            // 路由解析失败（UNKNOWN_MODEL/无 provider 等）也要留痕——记的是配置的路由而非解析结果
            devLogRecord({
                tag: this.tag, purpose: request.purpose, ts: localIso(new Date()), ok: false, stage: 'resolve-route',
                provider: this.route.provider || undefined, model: this.route.model || undefined,
                system: capField(request.system), prompt: capField(request.prompt),
                error: e instanceof Error ? e.message : String(e),
            });
            throw e;
        }
        this.log.info(`LLM summary via provider=${route.provider} model=${route.model}`);
        let lastReasoning = 0;
        let lastTail = '';
        const attempt = async (maxTokens, promptSuffix = '') => {
            // timeoutMs 按次生效：计时起点是本次尝试——排队等锁与空回复重试都不互吃预算
            const req = { ...request, maxTokens, prompt: request.prompt + promptSuffix };
            if (req.timeoutMs) {
                req.signal = AbortSignal.any([...(req.signal ? [req.signal] : []), AbortSignal.timeout(req.timeoutMs)]);
            }
            const message = createUserMessage({
                content: [{ type: 'text', text: req.prompt }],
                source: { kind: 'user' },
            });
            const stream = this.llm.stream({
                provider: route.provider,
                model: route.model,
                messages: [message],
                ...(req.system !== undefined ? { system: req.system } : {}),
                maxTokens: req.maxTokens,
                temperature: req.temperature,
                ...(req.signal !== undefined ? { signal: req.signal } : {}),
            });
            const diag = { reasoningChars: 0, tail: '' };
            const loopDetect = loopGuardOn() ? await loadLoopDetect(this.log) : null;
            const t0 = Date.now();
            const u0in = this.usage.inputTokens, u0out = this.usage.outputTokens;
            const base = {
                tag: this.tag, purpose: req.purpose, provider: route.provider, model: route.model,
                system: capField(req.system), prompt: capField(req.prompt),
            };
            try {
                const text = await collectText(idleWatch(stream, this.idleTimeoutMs, this.log), this.usage, diag, loopDetect ?? undefined);
                lastReasoning = diag.reasoningChars;
                const ms = Date.now() - t0;
                const rs = diag.reasoningChars ? ` reasoning=${diag.reasoningChars}c` : '';
                if (diag.loop)
                    this.log.warn(`LLM output loop cut: ${diag.loop}`);
                this.log.info(`LLM done: ${text.length} chars${rs ? `,${rs}` : ''}, ${Math.round(ms / 1000)}s`);
                diagLog(`ok ${route.provider}/${route.model} text=${text.length}c${rs} in=${this.usage.inputTokens} out=${this.usage.outputTokens} ms=${ms}`);
                const din = this.usage.inputTokens - u0in, dout = this.usage.outputTokens - u0out;
                const genMs = diag.genMs ?? 0;
                devLogRecord({
                    ...base, ts: localIso(new Date()), ok: true, ms, genMs,
                    in: din, out: dout,
                    tokPerSec: genMs > 0 && dout > 0 ? Math.round(dout / (genMs / 1000)) : undefined,
                    response: capField(text), reasoningChars: diag.reasoningChars || undefined,
                });
                return text;
            }
            catch (e) {
                lastReasoning = diag.reasoningChars;
                lastTail = diag.tail;
                if (req.signal?.aborted)
                    noteLlmAbort(); // 在飞请求中止→冷却打点：后续新 LLM 请求等 socket 拆完再发
                const tail = diag.tail ? ` tail="${diag.tail.slice(-200).replace(/\s+/g, ' ')}"` : '';
                diagLog(`FAIL ${route.provider}/${route.model} reasoning=${diag.reasoningChars}c ms=${Date.now() - t0} err="${e instanceof Error ? e.message : String(e)}"${tail}`);
                const din = this.usage.inputTokens - u0in, dout = this.usage.outputTokens - u0out;
                const genMs = diag.genMs ?? 0;
                devLogRecord({
                    ...base, ts: localIso(new Date()), ok: false, ms: Date.now() - t0, genMs,
                    in: din, out: dout,
                    tokPerSec: genMs > 0 && dout > 0 ? Math.round(dout / (genMs / 1000)) : undefined,
                    response: capField(diag.partial), error: e instanceof Error ? e.message : String(e),
                    reasoningChars: diag.reasoningChars || undefined,
                });
                throw e;
            }
        };
        try {
            return await attempt(request.maxTokens);
        }
        catch (e) {
            const emsg = e instanceof Error ? e.message : String(e);
            // 推理模型空补全自救：reasoning>0 的空输出＝思考吃光预算（summarizer 有同款翻倍重试，这里收口到所有调用）
            const boost = retryBudgetForEmpty(request.maxTokens, lastReasoning, emsg);
            if (boost != null) {
                this.log.warn(`LLM empty completion after ${lastReasoning}c reasoning — retry with maxTokens ${request.maxTokens ?? 'default'}→${boost}`);
                return await attempt(boost);
            }
            // 推理被死循环检测截流：分析成果在尾巴里——折回 prompt 让它跳过逐条分析直接收尾
            const cont = reasoningContinuation(request, lastReasoning, lastTail, emsg);
            if (cont != null) {
                this.log.warn(`LLM reasoning loop cut at ${lastReasoning}c — retry with analysis tail folded into prompt`);
                return await attempt(cont.maxTokens, cont.suffix);
            }
            throw e;
        }
    }
}
/** 推理模型空补全重试预算：reasoning>0 的空输出＝思考吃光预算——+12K 封顶 24K 给足二次机会；无 reasoning 的空输出是另一种病（prompt/服务问题），不放大 */
function retryBudgetForEmpty(maxTokens, reasoningChars, message) {
    if (reasoningChars <= 0 || !/empty completion/i.test(message))
        return undefined;
    const next = Math.min(24_576, (maxTokens ?? 4096) + 12_288);
    return next > (maxTokens ?? 0) ? next : undefined;
}
/** 推理被检测器判死循环截流的续写方案：截流≠没干活——reasoning 尾巴里存着已完成的逐条分析，
 *  折回 prompt 让它跳过分析直接给最终输出；预算 +8K（输出+残留思考），素材尾取 1K 防再次复读。 */
function reasoningContinuation(request, reasoningChars, tail, message) {
    if (!/reasoning loop detected/i.test(message) || reasoningChars < 2048 || tail.length < 64)
        return undefined;
    const excerpt = tail.slice(-1000).replace(/\s+/g, ' ').trim();
    return {
        maxTokens: Math.min(24_576, (request.maxTokens ?? 4096) + 8_192),
        suffix: `\n\n【续写指令】你之前已对本题做过详细分析，分析末尾片段如下：\n"${excerpt}"\n分析阶段已结束——不要再逐条分析或复述素材，直接输出最终答案。`,
    };
}
/** 流每块输出间隔上限：只掐"连上但不出字"的死连接；推理模型持续吐 reasoning 不受影响。 */
const LLM_IDLE_MS = 45_000;
async function* idleWatch(stream, idleMs, log) {
    const it = stream[Symbol.asyncIterator]();
    try {
        for (;;) {
            let timer;
            const r = await Promise.race([
                it.next(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new RssServiceError(`LLM stream idle for ${Math.round(idleMs / 1000)}s`)), idleMs);
                }),
            ]).finally(() => { if (timer !== undefined)
                clearTimeout(timer); });
            if (r.done)
                return;
            yield r.value;
        }
    }
    catch (e) {
        log.warn(`LLM stream aborted by idle watchdog: ${e instanceof Error ? e.message : e}`);
        // 底层流在半死时 return() 也可能永不 settle——fire-and-forget，
        // 否则这个 await 本身就把调用方（评分/翻译循环）永久挂死
        try {
            void it.return?.()?.catch(() => { });
        }
        catch { /* 尽力收尾 */ }
        throw e;
    }
}
//# sourceMappingURL=dsh-llm.js.map