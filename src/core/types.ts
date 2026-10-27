/** 核心类型：rss-digest 兼容字段名（移植模块直接用）+ 本项目扩展字段。 */

export type DigestLanguage = 'zh' | 'en'
export type SummaryMode = 'batch' | 'single'

/** 源健康度（滚动统计，见 SOURCES.md §5） */
export interface SourceHealth {
  ok: number
  fail: number
  /** 连续失败计数（成功即清零），≥3 触发 24h 冷却 */
  failStreak: number
  lastError?: string
  /** 最近 10 次响应延迟滚动均值（ms） */
  avgMs?: number
  /** 连续失败冷却截止 ISO；在冷却中跳过抓取 */
  cooldownUntil?: string
}

/** 订阅源（内置 + 用户源统一结构） */
export interface FeedSource {
  id: string
  url: string
  title: string
  enabled: boolean
  addedAt: string
  /** 分类（SOURCES.md §3 的 14 类） */
  category: string
  /** 质量权重 1最高/2/3，scorer 用 */
  tier: 1 | 2 | 3
  /** 主要语言 */
  lang: 'zh' | 'en'
  /** 抓取方式（预留 reader/镜像） */
  method: string
  /** 内置目录源 */
  builtin: boolean
  /** 用户权重微调（prefs.sourceWeight 合并结果，默认 1） */
  weight: number
  /** 该源条目是否生成 AI 逐条摘要（默认 true；false=日报里用 feed 原摘要） */
  summarize: boolean
  /** 该源走代理：'url'=指定代理，true=走全局 fetch.proxyUrl，缺省=直连 */
  proxy?: string | boolean
  /** 源级最小冷却小时数（覆盖默认 24h），连续失败时按它锁 */
  cooldownHours?: number
  health: SourceHealth
}

export interface ItemState {
  read: boolean
  hidden: boolean
  /** +1 like / -1 dislike / 0 */
  liked: 1 | -1 | 0
  /** 中文译文（翻译模型输出） */
  translation?: string
  /** 翻译失败原因（诊断用） */
  translationError?: string
}

/** 归一化条目 */
export interface FeedItem {
  id: string
  sourceId: string
  title: string
  link: string
  summary: string
  content: string
  publishedAt: string
  /** 首次入 store 时间（merge 时继承旧值，兼作 firstSeenAt） */
  fetchedAt: string
  hash: string
  /** 已进哪天的日报（YYYY-MM-DD） */
  digestedDay: string
  /** 主题分类（继承 source.category 或后续推断） */
  topic: string
  /** scorer 输出 */
  score: number
  /** 推荐理由（"新鲜度+偏好命中"） */
  reasons: string[]
  /** AI 一句话摘要与失败原因（逐条降级字段） */
  aiSummary?: string
  aiSummaryError?: string
  state: ItemState
}

export interface SourceFetchResult {
  sourceId: string
  sourceUrl: string
  fetched: number
  added: number
  duplicated: number
  error?: string
}

export interface FetchCycleResult {
  startedAt: string
  finishedAt: string
  sources: SourceFetchResult[]
  totalFetched: number
  totalAdded: number
  errors: number
}

export interface DigestDocument {
  title: string
  date: string
  language: DigestLanguage
  markdown: string
  itemCount: number
  itemIds: string[]
  summarySource: 'llm' | 'extractive'
  degraded: boolean
  note: string
  /** 本次日报的 LLM token 用量（无 LLM/未上报时为 undefined） */
  tokens?: { inputTokens: number; outputTokens: number; estimated?: boolean }
}

export interface ParsedFeedItem {
  title: string
  link: string
  summary: string
  content: string
  publishedAt: string
  id: string
}

export interface ParsedFeed {
  title: string
  items: ParsedFeedItem[]
}

export interface FetchedDocument {
  url: string
  status: number
  body: string
}

export interface FetchFailure {
  url: string
  status: number
  error: string
  retryable?: boolean
}

export interface LogSink {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
}

export const noopLog: LogSink = {
  info() {},
  warn() {},
  error() {},
}
