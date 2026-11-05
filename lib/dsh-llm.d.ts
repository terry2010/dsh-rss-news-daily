/**
 * Adapter that routes summarization through the host's `ctx.llm` service.
 *
 * Provider/model resolution is deferred to the first call so that HMR or late
 * registrations (e.g. the DeepSeek adapter activating after startup) are
 * honored. When no adapter is registered yet the call fails loudly and the
 * summarizer degrades to its extractive fallback.
 */
import type { LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { LlmClient, LlmTextRequest } from './summarizer.js';
import type { LogSink } from './core/types.js';
export interface DshLlmRoute {
    provider: string;
    model: string;
}
/** Pick a live provider/model pair honoring configured values. */
export declare function resolveDshRoute(llm: LlmRuntime, route: DshLlmRoute): Promise<{
    provider: string;
    model: string;
}>;
/** 诊断信息：reasoning 长度累计 + 截尾样本（死循环时尾巴就是复读内容）。 */
export interface CollectDiag {
    reasoningChars: number;
    tail: string;
}
export declare function setLlmDiagFile(path: string): void;
/** dsh-loop-recover 的检测器（装了就用，没装就跳过——它只拦 agent 循环，不护我们的旁路调用）。
 *  变量形式的 specifier 让 tsc 不做静态解析——该包是宿主 profile 的可选共存插件，非本包依赖。 */
type LoopHit = {
    kind?: string;
    cutStart?: number;
};
type LoopDetect = (text: string) => LoopHit | null;
export declare function setLoopGuardEnabled(fn: () => boolean): void;
/** 检测器实际状态：供 /api/loopguard 告诉用户"装了但没启用/根本没装" */
export declare function loopDetectStatus(): 'untested' | 'active' | 'absent';
/** Accumulate a stream into plain text, surfacing terminal failures. usage 传入对象则原地累计 token 用量（流中 usage 为累计值，取最新）。loopDetect 命中即截流。 */
export declare function collectText(stream: AsyncIterable<StreamChunk>, usage?: {
    inputTokens: number;
    outputTokens: number;
    _seen?: number;
    _seenOut?: number;
}, diag?: CollectDiag & {
    loop?: string;
}, loopDetect?: LoopDetect): Promise<string>;
/** {@link LlmClient} backed by the harness `ctx.llm` streaming service. */
export declare class DshLlmClient implements LlmClient {
    private readonly llm;
    private readonly route;
    private readonly log;
    private readonly idleTimeoutMs;
    private resolution?;
    /** 本 client 生命周期内的累计 token 用量（pipeline 每次 digest 新建实例 → 即单次日报用量） */
    readonly usage: {
        inputTokens: number;
        outputTokens: number;
        _seen?: number;
        _seenOut?: number;
    };
    constructor(llm: LlmRuntime, route: DshLlmRoute, log: LogSink, idleTimeoutMs?: number);
    generateText(request: LlmTextRequest): Promise<string>;
    private call;
}
export {};
//# sourceMappingURL=dsh-llm.d.ts.map