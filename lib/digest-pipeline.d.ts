/**
 * 日报管线：候选 → 打分精选 → 逐条摘要（逐条降级）→ 整体总结（整段降级）
 * → 渲染落盘 → 标记已推 + meta.lastDigestDay。
 *
 * 铁律 2：任何一条/一段 LLM 失败只降级该处，日报永远产出。
 */
import type { DigestDocument, DigestLanguage, FeedItem, LogSink } from './core/types.js';
import type { StoreLike } from './core/store.js';
import type { LlmClient } from './summarizer.js';
import type { Prefs } from './core/scorer.js';
export interface DigestPipelineOptions {
    store: StoreLike;
    configSources: Array<{
        url: string;
        title?: string;
        category?: string;
        enabled?: boolean;
    }>;
    llmClient?: LlmClient;
    llmEnabled: boolean;
    summaryEnabled: boolean;
    summaryMaxItems: number;
    summaryConcurrency: number;
    summaryMaxLength: number;
    /** LLM 单次调用超时（流挂起兜底，防 digestRunning 闩锁） */
    llmTimeoutMs: number;
    /** 外部取消信号（「停止生成」）；与 llmTimeoutMs 合并为任一触发即停 */
    signal?: AbortSignal;
    /** 指定生成的目标日（yyyy-mm-dd），缺省按 now 所在日 */
    day?: string;
    /** 订阅分类（缺省/空=全部订阅）；不在表内的 topic 不进日报候选池 */
    subscribedTopics?: string[];
    /** 日报补评无分候选（存量/评分失败兜底），默认 true */
    rescoreMissing?: boolean;
    /** 翻译用 LLM client（translateLlm 路由）；存在时对英文条目生成中英对照译文 */
    translateClient?: LlmClient;
    /** 每完成一条回调（done, total, stage）——stage: summaries/translate/finishing，进度上报用 */
    onItemDone?: (done: number, total: number, stage?: string) => void;
    /** LLM maxTokens（config 透传，不再用 summarizer 内算值） */
    llmMaxTokens: number;
    digestItems: number;
    perTopicLimit: number;
    digestMaxLength: number;
    language: DigestLanguage;
    timezone: string;
    digestsDir: string;
    prefs?: Prefs;
    log?: LogSink;
    now?: Date;
    /** 候选池 = 最近 N 小时内的条目；0=不限 */
    candidateHours?: number;
    /** 跨日降权的窗口天数（dedupe.windowDays；0=不罚） */
    penaltyWindowDays?: number;
    /** force 重跑：纳入当日已推条目重算（news_regen /api/digest-run force 语义） */
    force?: boolean;
    /** P1 抓取后评分进度回调（done,total=已处理块覆盖/待评条数）——fetch-progress 的 score 段用 */
    onScoreProgress?: (done: number, total: number) => void;
    /** v2：LLM 评分候选池上限（启发式粗排后取前 N）；0=关闭用纯启发式 */
    llmScoreCandidates?: number;
    /** v2：LLM 评分入选阈值（1-10），评过分的低于此值不入选 */
    minLlmScore?: number;
    /** v2：同题新闻合并去重（标题 token 重叠聚类） */
    dedupeStories?: boolean;
    /** v2：分类→输出指令映射（覆盖内置默认） */
    categoryPrompts?: Record<string, string>;
}
/** 外文判定：非汉字字母（拉丁/谚文/假名/西里尔等）≥10 个且超过汉字数 2 倍才算外文。
 *  旧规则按字符占比 ≤50% 判定，中文标题夹带型号/产品名（Windows 8GB、GPT-6）
 *  会被误判送翻译、模型原样回显；改按"文字脚本占比"判定，URL 不计入。 */
export declare function textLooksForeign(text: string): boolean;
/** P1 抓取后评分：本轮新条目本批去重 → 分块批量评分（无分跳过幂等）；返回评出条数。 */
export declare function scoreNewItems(items: FeedItem[], client: LlmClient, opts: Pick<DigestPipelineOptions, 'llmTimeoutMs' | 'llmScoreCandidates' | 'llmMaxTokens' | 'signal' | 'prefs' | 'onScoreProgress'>, log: LogSink): Promise<number>;
/** P8 时段快报：高分条目按领域分组追加/覆盖 `## HH:mm 时段快报` 节（{day}-hourly.md）。 */
export declare function appendHourlyBrief(opts: {
    items: FeedItem[];
    sourcesById: Map<string, {
        title: string;
    }>;
    day: string;
    time: string;
    minScore: number;
    digestsDir: string;
    llmClient?: LlmClient;
    translateClient?: LlmClient;
    summaryConcurrency?: number;
    signal?: AbortSignal;
    onItemDone?: (done: number, total: number, stage?: string) => void;
    llmTimeoutMs?: number;
    llmMaxTokens?: number;
    log?: LogSink;
}): Promise<number>;
/** 生成并落盘当日日报；返回 DigestDocument（含 degraded/note 元数据）。 */
export declare function runDailyDigest(opts: DigestPipelineOptions): Promise<DigestDocument>;
//# sourceMappingURL=digest-pipeline.d.ts.map