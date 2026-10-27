/**
 * 插件配置：类型 + Cordis/Schemastery `Config`。
 *
 * 铁律 1：所有数量限制一律走 config，无硬编码上限。
 * 每个字段都有默认值，空 patch config 即可运行。
 */

import Schema from '@deepseek-ai/schemastery'

/** 预置订阅源（cordis 配置层；运行时增删走 tools/API/OPML，见 SOURCES.md L2） */
export interface FeedSourceInput {
  url: string
  title?: string
  category?: string
  enabled?: boolean
}

export interface FetchSectionConfig {
  /** 周期轮询开关 */
  enabled: boolean
  /** 轮询间隔（分钟，≥5） */
  intervalMinutes: number
  /** 启动约 10s 后执行首轮 */
  onStartup: boolean
  /** 抓取并发数 */
  concurrency: number
  /** 单请求超时（ms） */
  requestTimeoutMs: number
  /** feed 文档大小上限（字节） */
  sizeLimitBytes: number
  /** 瞬时故障重试次数 */
  retries: number
  /** 每源每轮保留条目数 */
  maxItemsPerSource: number
  /** 正文/摘要存储截断（字符） */
  storeContentChars: number
  /** 条目保留上限（按抓取时间裁最旧） */
  maxStoredItems: number
  /** 可选 HTTP 代理 */
  proxyUrl: string
}

export interface DedupeSectionConfig {
  /** 跨天去重窗口（日历天）；窗口内推过的条目降权并标注；0=关 */
  windowDays: number
  /** Jaccard 近似重复阈值 */
  threshold: number
}

export interface ScheduleSectionConfig {
  /** 每日日报生成时刻列表（HH:MM）；空=回落 [dailyTime] */
  digestTimes: string[]
  /** 墙钟定点抓取时刻列表（HH:MM）；与 intervalMinutes 轮询并存 */
  fetchTimes: string[]
}

export interface LlmSectionConfig {
  /** 是否调用 LLM；false 时总结段走抽取式、逐条摘要关闭 */
  enabled: boolean
  /** provider 路由；与 model 成对，都空=宿主默认模型 */
  provider: string
  /** 模型 id */
  model: string
  /** 单次调用 token 上限（推理 token 与正文共享，勿调小） */
  maxTokens: number
  /** 单次调用超时（ms） */
  timeoutMs: number
}

export interface SummarySectionConfig {
  /** 逐条一句话摘要总开关 */
  enabled: boolean
  /** 给评分前 N 条生成摘要 */
  maxItems: number
  /** 摘要并发 */
  concurrency: number
  /** 单条一句话字数上限 */
  maxLength: number
}

export interface DigestSectionConfig {
  /** 每日精选条数（用户核心诉求；schema 上限仅为输入校验护栏，业务逻辑无隐藏硬顶） */
  digestItems: number
  /** 单一主题在精选里最多几条；0=不限 */
  perTopicLimit: number
  /** 整体总结段字数上限 */
  maxLength: number
}

export interface Config {
  /** 总开关 */
  enabled: boolean
  /** 数据目录；空=~/.dsh/rss-news-daily */
  dataDir: string
  /** 日报生成时刻 HH:MM */
  dailyTime: string
  /** IANA 时区；空=主机本地 */
  timezone: string
  /** 错过时段开机补跑窗口（小时） */
  catchUpHours: number
  /** 预置订阅源（与内置/用户源按规范化 URL 合并） */
  sources: FeedSourceInput[]
  /** 超期索引归档压缩天数；0=不压缩 */
  archiveAfterDays: number
  /** 阅读器每页条数 */
  readerPageSize: number
  /** macOS 系统通知开关（定时采集完成时） */
  notifyEnabled: boolean
  /** 通知正文列几条标题 */
  notifyMaxTitles: number
  fetch: FetchSectionConfig
  dedupe: DedupeSectionConfig
  llm: LlmSectionConfig
  summary: SummarySectionConfig
  digest: DigestSectionConfig
  schedule: ScheduleSectionConfig
}

const FeedSourceSchema = Schema.object({
  url: Schema.string().required().description('Feed URL (http/https).'),
  title: Schema.string().description('显示名。'),
  category: Schema.string().description('分类（见 SOURCES.md §3）。'),
  enabled: Schema.boolean().default(true),
  summarize: Schema.boolean().default(true).description('该源条目是否生成 AI 逐条摘要。'),
})

const FetchSectionSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  intervalMinutes: Schema.number().min(5).default(60),
  onStartup: Schema.boolean().default(true),
  concurrency: Schema.natural().min(1).max(16).default(6),
  requestTimeoutMs: Schema.number().min(1000).default(15_000),
  sizeLimitBytes: Schema.number().min(1024).default(3 * 1024 * 1024),
  retries: Schema.natural().min(0).default(2),
  maxItemsPerSource: Schema.natural().min(1).default(50),
  storeContentChars: Schema.natural().min(100).default(4000),
  maxStoredItems: Schema.natural().min(10).default(2000),
  proxyUrl: Schema.string().default(''),
}).description('抓取策略。')

const DedupeSectionSchema = Schema.object({
  windowDays: Schema.natural().min(0).default(3),
  threshold: Schema.percent().default(0.85),
}).description('去重策略。')

const LlmSectionSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  provider: Schema.string().default('').description('provider 路由；与 model 成对，都空=宿主默认。'),
  model: Schema.string().default('').description('模型 id；与 provider 成对。'),
  maxTokens: Schema.natural().min(256).default(4096),
  timeoutMs: Schema.number().min(5000).default(60_000),
}).description('LLM 路由与预算。')

const SummarySectionSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  maxItems: Schema.natural().min(1).default(20),
  concurrency: Schema.natural().min(1).max(8).default(3),
  maxLength: Schema.natural().min(10).max(200).default(50),
}).description('逐条一句话摘要。')

const DigestSectionSchema = Schema.object({
  digestItems: Schema.natural().min(1).max(200).default(20),
  perTopicLimit: Schema.natural().min(0).default(4),
  maxLength: Schema.natural().min(50).max(3000).default(800),
}).description('日报格式。')

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/

const ScheduleSectionSchema = Schema.object({
  digestTimes: Schema.array(Schema.string().pattern(TIME_RE)).default([]).description('每日日报生成时刻列表（HH:MM）；空=用 dailyTime。'),
  fetchTimes: Schema.array(Schema.string().pattern(TIME_RE)).default([]).description('墙钟定点抓取时刻列表（HH:MM）；与 intervalMinutes 轮询并存。'),
}).description('多时间点定时。')

export const Config: Schema<Config> = Schema.object({
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
})
