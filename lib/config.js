/**
 * 插件配置：类型 + Cordis/Schemastery `Config`。
 *
 * 铁律 1：所有数量限制一律走 config，无硬编码上限。
 * 每个字段都有默认值，空 patch config 即可运行。
 */
import Schema from '@deepseek-ai/schemastery';
const FeedSourceSchema = Schema.object({
    url: Schema.string().required().description('Feed URL (http/https).'),
    title: Schema.string().description('显示名。'),
    category: Schema.string().description('分类（见 SOURCES.md §3）。'),
    enabled: Schema.boolean().default(true),
    summarize: Schema.boolean().default(true).description('该源条目是否生成 AI 逐条摘要。'),
});
const FetchSectionSchema = Schema.object({
    enabled: Schema.boolean().default(true),
    intervalMinutes: Schema.number().min(5).default(60),
    scoreOnFetch: Schema.boolean().default(true).description('抓取后对新条目全量 LLM 评分（分块批量）'),
    hourlyBrief: Schema.boolean().default(true).description('抓取评分后生成时段快报（{day}-hourly.md）'),
    hourlyMinScore: Schema.number().min(0).max(10).default(6).description('时段快报入选分阈值'),
    onStartup: Schema.boolean().default(true),
    concurrency: Schema.natural().min(1).max(16).default(6),
    requestTimeoutMs: Schema.number().min(1000).default(15_000),
    sizeLimitBytes: Schema.number().min(1024).default(3 * 1024 * 1024),
    retries: Schema.natural().min(0).default(2),
    maxItemsPerSource: Schema.natural().min(1).default(50),
    storeContentChars: Schema.natural().min(100).default(4000),
    maxStoredItems: Schema.natural().min(10).default(30000),
    proxyUrl: Schema.string().default(''),
}).description('抓取策略。');
const DedupeSectionSchema = Schema.object({
    windowDays: Schema.natural().min(0).default(3),
    threshold: Schema.percent().default(0.85),
}).description('去重策略。');
const LlmSectionSchema = Schema.object({
    enabled: Schema.boolean().default(true),
    provider: Schema.string().default('').description('provider 路由；与 model 成对，都空=宿主默认。'),
    model: Schema.string().default('').description('模型 id；与 provider 成对。'),
    maxTokens: Schema.natural().min(256).default(8192),
    timeoutMs: Schema.number().min(5000).default(180_000),
}).description('LLM 路由与预算。');
const SummarySectionSchema = Schema.object({
    enabled: Schema.boolean().default(true),
    maxItems: Schema.natural().min(1).default(20),
    concurrency: Schema.natural().min(1).max(8).default(3),
    maxLength: Schema.natural().min(10).max(200).default(50),
}).description('逐条一句话摘要。');
const DigestSectionSchema = Schema.object({
    digestItems: Schema.natural().min(1).max(200).default(100),
    perTopicLimit: Schema.natural().min(0).default(4),
    maxLength: Schema.natural().min(50).max(3000).default(800),
    llmScoreCandidates: Schema.natural().min(0).max(200).default(40).description('LLM 评分候选池；0=关闭 LLM 评分。'),
    minLlmScore: Schema.natural().min(1).max(10).default(5).description('LLM 评分入选阈值（1-10）。'),
    dedupeStories: Schema.boolean().default(true).description('同题新闻合并去重。'),
    rescoreMissing: Schema.boolean().default(true).description('日报补评无分候选条目。'),
    categoryPrompts: Schema.dict(Schema.string()).default({}).description('分类→输出指令映射。'),
}).description('日报格式。');
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const ScheduleSectionSchema = Schema.object({
    digestTimes: Schema.array(Schema.string().pattern(TIME_RE)).default([]).description('每日日报生成时刻列表（HH:MM）；空=用 dailyTime。'),
    fetchTimes: Schema.array(Schema.string().pattern(TIME_RE)).default([]).description('墙钟定点抓取时刻列表（HH:MM）；与 intervalMinutes 轮询并存。'),
}).description('多时间点定时。');
export const Config = Schema.object({
    enabled: Schema.boolean().default(true),
    dataDir: Schema.string().default('').description('数据目录；空=~/.dsh/rss-news-daily。'),
    dailyTime: Schema.string().pattern(/^([01]?\d|2[0-3]):[0-5]\d$/).default('08:00'),
    timezone: Schema.string().default('').description('IANA 时区（如 Asia/Shanghai）；空=主机本地。'),
    catchUpHours: Schema.natural().min(0).max(72).default(12),
    schedule: ScheduleSectionSchema,
    sources: Schema.array(FeedSourceSchema).default([]),
    archiveAfterDays: Schema.natural().min(0).default(60),
    readerPageSize: Schema.natural().min(10).max(200).default(50),
    notifyEnabled: Schema.boolean().default(false),
    notifyMaxTitles: Schema.natural().min(1).max(10).default(3),
    fetch: FetchSectionSchema,
    dedupe: DedupeSectionSchema,
    llm: LlmSectionSchema,
    summary: SummarySectionSchema,
    digest: DigestSectionSchema,
});
//# sourceMappingURL=config.js.map