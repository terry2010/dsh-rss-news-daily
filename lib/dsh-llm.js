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
            if (usage && u) {
                if (typeof u.inputTokens === 'number')
                    usage.inputTokens += u.inputTokens - (usage._seen ?? 0); // 累计值取增量
                if (typeof u.outputTokens === 'number')
                    usage.outputTokens += u.outputTokens - (usage._seenOut ?? 0);
                if (typeof u.inputTokens === 'number')
                    usage._seen = u.inputTokens;
                if (typeof u.outputTokens === 'number')
                    usage._seenOut = u.outputTokens;
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
                        diag.tail = (diag.tail + chunk.text).slice(-600);
                    }
                    if (loopDetect) {
                        reasoningBuf = (reasoningBuf + chunk.text).slice(-8192);
                        const totalR = diag?.reasoningChars ?? reasoningBuf.length; // 增量按总量计：buffer 有上限，到顶后 length 不再涨
                        if (reasoningBuf.length >= 2048 && totalR - lastReasoningCheck >= 2048) {
                            lastReasoningCheck = totalR;
                            if (loopDetect(reasoningBuf))
                                throw new RssServiceError(`LLM reasoning loop detected (reasoning ${totalR} chars)`);
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
/** {@link LlmClient} backed by the harness `ctx.llm` streaming service. */
export class DshLlmClient {
    llm;
    route;
    log;
    idleTimeoutMs;
    tag;
    resolution;
    /** 本 client 生命周期内的累计 token 用量（pipeline 每次 digest 新建实例 → 即单次日报用量） */
    usage = { inputTokens: 0, outputTokens: 0 };
    constructor(llm, route, log, tag = 'llm', idleTimeoutMs = LLM_IDLE_MS) {
        this.llm = llm;
        this.route = route;
        this.log = log;
        this.idleTimeoutMs = idleTimeoutMs;
        this.tag = tag;
    }
    async generateText(request) {
        try {
            return await this.call(request);
        }
        catch (error) {
            // 部分本地模型（translategemma 等）chat template 不支持 system 首条——
            // 把 system 折进 user prompt 重试一次，而不是整条翻译链失败
            const reason = error instanceof Error ? error.message : String(error);
            if (request.system !== undefined && /chat template|must start with a user/i.test(reason)) {
                this.log.warn(`LLM rejected system prompt, retrying folded into user message: ${reason.slice(0, 140)}`);
                return this.call({ ...request, system: undefined, prompt: `${request.system}\n\n${request.prompt}` });
            }
            throw error;
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
        const message = createUserMessage({
            content: [{ type: 'text', text: request.prompt }],
            source: { kind: 'user' },
        });
        const stream = this.llm.stream({
            provider: route.provider,
            model: route.model,
            messages: [message],
            ...(request.system !== undefined ? { system: request.system } : {}),
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            ...(request.signal !== undefined ? { signal: request.signal } : {}),
        });
        const diag = { reasoningChars: 0, tail: '' };
        const loopDetect = loopGuardOn() ? await loadLoopDetect(this.log) : null;
        const t0 = Date.now();
        const u0in = this.usage.inputTokens, u0out = this.usage.outputTokens;
        const base = {
            tag: this.tag, purpose: request.purpose, provider: route.provider, model: route.model,
            system: capField(request.system), prompt: capField(request.prompt),
        };
        try {
            const text = await collectText(idleWatch(stream, this.idleTimeoutMs, this.log), this.usage, diag, loopDetect ?? undefined);
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
    }
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