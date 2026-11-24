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
    genMs?: number;
    partial?: string;
}
export declare function setLlmDiagFile(path: string): void;
export declare function setDevLogDir(dir: string): void;
export declare function setDevLogEnabled(fn: () => boolean): void;
/** dsh-loop-recover 的检测器（装了就用，没装就跳过——它只拦 agent 循环，不护我们的旁路调用）。
 *  变量形式的 specifier 让 tsc 不做静态解析——该包是宿主 profile 的可选共存插件，非本包依赖。 */
type LoopHit = {
    kind?: string;
    detail?: string;
    evidence?: string;
    cutStart?: number;
};
type LoopDetect = (text: string, options?: Record<string, number>) => LoopHit | null;
export declare function setLoopGuardEnabled(fn: () => boolean): void;
/** 检测器实际状态：供 /api/loopguard 告诉用户"装了但没启用/根本没装" */
export declare function loopDetectStatus(): 'untested' | 'active' | 'absent';
/** Accumulate a stream into plain text, surfacing terminal failures. usage 传入对象则原地累计 token 用量（流中 usage 为累计值，取最新）。loopDetect 命中即截流。 */
export declare function collectText(stream: AsyncIterable<StreamChunk>, usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    _seen?: number;
    _seenOut?: number;
    _seenCache?: number;
}, diag?: CollectDiag & {
    loop?: string;
}, loopDetect?: LoopDetect): Promise<string>;
export declare function setLlmConcurrency(fn: () => number): void;
/** LLM 队列快照：tagSet 圈定「本任务」客户端 tag 集合，进度端据此区分「在执行」与「排队等锁」。
 * tagAhead = 排在本任务首个排队调用之前的调用数 + 正占着槽位的他人调用数（并发=1 时即"还要等几个调用完成"） */
export declare function llmQueueSnapshot(tagSet?: readonly string[]): {
    limit: number;
    running: number;
    queued: number;
    tagRunning: number;
    tagQueued: number;
    tagAhead: number;
    /** 本任务排队中的调用明细（purpose 列表，长度===tagQueued） */
    mineQueued: string[];
    /** 前方占用明细：在飞的他人调用 + 队列里排在本任务之前的调用（长度===tagAhead） */
    ahead: string[];
};
export interface LlmDurState {
    global?: number;
    byPurpose?: Record<string, number>;
}
/** 某类调用的滑动平均耗时 ms；该桶无样本退全局均值，再无样本 undefined（前端据此显示「估算中」） */
export declare function llmCallAvgMs(purpose?: string): number | undefined;
export declare function setLlmDurPersistence(p: {
    save?: (s: LlmDurState) => void;
} | null): void;
/** 灌回持久化的 EMA——插件启动 store.load() 完成后调用 */
export declare function setLlmDurState(s: LlmDurState | undefined): void;
/** {@link LlmClient} backed by the harness `ctx.llm` streaming service. */
export declare class DshLlmClient implements LlmClient {
    private readonly llm;
    private readonly route;
    private readonly log;
    private readonly idleTimeoutMs;
    private readonly tag;
    private resolution?;
    /** 模型暴露的 reasoning effort 档位（随路由一次性探测）：undefined=未探测 null=模型无档位 */
    private efforts?;
    /** 本 client 生命周期内的累计 token 用量（pipeline 每次 digest 新建实例 → 即单次日报用量） */
    readonly usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        _seen?: number;
        _seenOut?: number;
        _seenCache?: number;
    };
    constructor(llm: LlmRuntime, route: DshLlmRoute, log: LogSink, tag?: string, idleTimeoutMs?: number);
    generateText(request: LlmTextRequest): Promise<string>;
    /** 把请求的 effort 意图映射到模型实际暴露的档位：精确匹配优先；
     *  'off'＝优先选关断义档位（off/none/disabled 类命名），无则取最低档近似关断；
     *  'min'/'max' 意图词取最低/最高档（efforts 按 least→greatest 排序）。模型没声明档位、
     *  或请求档位无匹配——丢弃并一次性告警（优雅降级照常调用），绝不传不支持的档位让 adapter 拒掉。 */
    private resolveEffort;
    private call;
}
export declare function isSystemicLlmError(e: unknown): boolean;
/** 连续同型系统性失败熔断阈值 */
export declare const LLM_SYSTEMIC_STREAK = 3;
/** 连续任意失败兜底熔断阈值（系统性判定漏网时仍有上限） */
export declare const LLM_FAIL_STREAK = 10;
export {};
//# sourceMappingURL=dsh-llm.d.ts.map