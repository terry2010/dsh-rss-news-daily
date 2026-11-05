/**
 * 插件配置：类型 + Cordis/Schemastery `Config`。
 *
 * 铁律 1：所有数量限制一律走 config，无硬编码上限。
 * 每个字段都有默认值，空 patch config 即可运行。
 */
import Schema from '@deepseek-ai/schemastery';
/** 预置订阅源（cordis 配置层；运行时增删走 tools/API/OPML，见 SOURCES.md L2） */
export interface FeedSourceInput {
    url: string;
    title?: string;
    category?: string;
    enabled?: boolean;
}
export interface FetchSectionConfig {
    /** 周期轮询开关 */
    enabled: boolean;
    /** 轮询间隔（分钟，≥5） */
    intervalMinutes: number;
    /** 启动约 10s 后执行首轮 */
    onStartup: boolean;
    /** 抓取并发数 */
    concurrency: number;
    /** 单请求超时（ms） */
    requestTimeoutMs: number;
    /** feed 文档大小上限（字节） */
    sizeLimitBytes: number;
    /** 抓取后全量 LLM 评分（分块批量） */
    scoreOnFetch: boolean;
    /** 评分后生成时段快报 */
    hourlyBrief: boolean;
    /** 快报入选分阈值 */
    hourlyMinScore: number;
    /** 瞬时故障重试次数 */
    retries: number;
    /** 每源每轮保留条目数 */
    maxItemsPerSource: number;
    /** 正文/摘要存储截断（字符） */
    storeContentChars: number;
    /** 条目保留上限（按抓取时间裁最旧） */
    maxStoredItems: number;
    /** 可选 HTTP 代理 */
    proxyUrl: string;
}
export interface DedupeSectionConfig {
    /** 跨天去重窗口（日历天）；窗口内推过的条目降权并标注；0=关 */
    windowDays: number;
    /** Jaccard 近似重复阈值 */
    threshold: number;
}
export interface ScheduleSectionConfig {
    /** 每日日报生成时刻列表（HH:MM）；空=回落 [dailyTime] */
    digestTimes: string[];
    /** 墙钟定点抓取时刻列表（HH:MM）；与 intervalMinutes 轮询并存 */
    fetchTimes: string[];
}
export interface LlmSectionConfig {
    /** 是否调用 LLM；false 时总结段走抽取式、逐条摘要关闭 */
    enabled: boolean;
    /** provider 路由；与 model 成对，都空=宿主默认模型 */
    provider: string;
    /** 模型 id */
    model: string;
    /** 单次调用 token 上限（推理 token 与正文共享，勿调小） */
    maxTokens: number;
    /** 单次调用超时（ms） */
    timeoutMs: number;
}
export interface SummarySectionConfig {
    /** 逐条一句话摘要总开关 */
    enabled: boolean;
    /** 给评分前 N 条生成摘要 */
    maxItems: number;
    /** 摘要并发 */
    concurrency: number;
    /** 单条一句话字数上限 */
    maxLength: number;
}
export interface DigestSectionConfig {
    /** 每日精选条数（用户核心诉求；schema 上限仅为输入校验护栏，业务逻辑无隐藏硬顶） */
    digestItems: number;
    /** 单一主题在精选里最多几条；0=不限 */
    perTopicLimit: number;
    /** 整体总结段字数上限 */
    maxLength: number;
    /** LLM 评分候选池上限（启发式粗排后取前 N 进 LLM）；0=关闭用纯启发式 */
    llmScoreCandidates: number;
    /** LLM 评分入选阈值（1-10）；LLM 评过分的低于此值不入选 */
    minLlmScore: number;
    /** 同题新闻合并去重 */
    dedupeStories: boolean;
    /** 日报补评无分候选（存量/评分失败兜底） */
    rescoreMissing: boolean;
    /** 分类→输出指令映射（覆盖内置默认，如 {"AI":"重点讲对从业者的影响"}） */
    categoryPrompts: Record<string, string>;
}
export interface Config {
    /** 总开关 */
    enabled: boolean;
    /** 数据目录；空=~/.dsh/rss-news-daily */
    dataDir: string;
    /** 日报生成时刻 HH:MM */
    dailyTime: string;
    /** IANA 时区；空=主机本地 */
    timezone: string;
    /** 错过时段开机补跑窗口（小时） */
    catchUpHours: number;
    /** 预置订阅源（与内置/用户源按规范化 URL 合并） */
    sources: FeedSourceInput[];
    /** 超期索引归档压缩天数；0=不压缩 */
    archiveAfterDays: number;
    /** 阅读器每页条数 */
    readerPageSize: number;
    /** macOS 系统通知开关（定时采集完成时） */
    notifyEnabled: boolean;
    /** 通知正文列几条标题 */
    notifyMaxTitles: number;
    fetch: FetchSectionConfig;
    dedupe: DedupeSectionConfig;
    llm: LlmSectionConfig;
    summary: SummarySectionConfig;
    digest: DigestSectionConfig;
    schedule: ScheduleSectionConfig;
}
export declare const Config: Schema<Config>;
//# sourceMappingURL=config.d.ts.map