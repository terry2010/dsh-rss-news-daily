/**
 * 日报管线：候选 → 打分精选 → 逐条摘要（逐条降级）→ 整体总结（整段降级）
 * → 渲染落盘 → 标记已推 + meta.lastDigestDay。
 *
 * 铁律 2：任何一条/一段 LLM 失败只降级该处，日报永远产出。
 */

import { mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'

import type { DigestDocument, DigestLanguage, FeedItem, LogSink } from './core/types.js'
import { noopLog } from './core/types.js'
import type { Store } from './core/store.js'
import type { LlmClient } from './summarizer.js'
import { summarize } from './summarizer.js'
import type { SummarizableItem } from './summarizer.js'
import { renderDigest, digestFileName } from './digest.js'
import { scoreAndSelect } from './core/scorer.js'
import type { Prefs } from './core/scorer.js'
import { zonedDayKey } from './core/time.js'
import { effectiveSources } from './service.js'
import { truncateCodePoints } from './core/parser.js'

export interface DigestPipelineOptions {
  store: Store
  configSources: Array<{ url: string; title?: string; category?: string; enabled?: boolean }>
  llmClient?: LlmClient
  llmEnabled: boolean
  summaryEnabled: boolean
  summaryMaxItems: number
  summaryConcurrency: number
  summaryMaxLength: number
  /** LLM 单次调用超时（流挂起兜底，防 digestRunning 闩锁） */
  llmTimeoutMs: number
  /** 外部取消信号（「停止生成」）；与 llmTimeoutMs 合并为任一触发即停 */
  signal?: AbortSignal
  /** 翻译用 LLM client（translateLlm 路由）；存在时对英文条目生成中英对照译文 */
  translateClient?: LlmClient
  /** 每完成一条逐条摘要回调（done, total），进度上报用 */
  onItemDone?: (done: number, total: number) => void
  /** LLM maxTokens（config 透传，不再用 summarizer 内算值） */
  llmMaxTokens: number
  digestItems: number
  perTopicLimit: number
  digestMaxLength: number
  language: DigestLanguage
  timezone: string
  digestsDir: string
  prefs?: Prefs
  log?: LogSink
  now?: Date
  /** 候选池 = 最近 N 小时内的条目；0=不限 */
  candidateHours?: number
  /** 跨日降权的窗口天数（dedupe.windowDays；0=不罚） */
  penaltyWindowDays?: number
  /** force 重跑：纳入当日已推条目重算（news_regen /api/digest-run force 语义） */
  force?: boolean
}

function toSummarizable(item: FeedItem, sourceTitle: string): SummarizableItem {
  return {
    title: item.title,
    link: item.link,
    summary: item.summary,
    content: item.content,
    sourceTitle,
    publishedAt: item.publishedAt,
  }
}

/** 逐条翻译：CJK 占比 ≤50% 的条目调翻译模型写 state.translation（'标题\n\n正文'），日报渲染中英对照。 */
async function translateItems(items: FeedItem[], client: LlmClient, opts: DigestPipelineOptions): Promise<void> {
  const targets = items.filter((i) => {
    const t = i.title + (i.summary || '')
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length
    return cjk * 2 <= t.replace(/\s/g, '').length
  })
  const queue = [...targets]
  const workers = Array.from({ length: Math.max(1, opts.summaryConcurrency) }, async () => {
    for (;;) {
      if (opts.signal?.aborted) return
      const item = queue.shift()
      if (!item) return
      try {
        const text = await client.generateText({
          system: '你是翻译助手。把给定新闻标题和摘要翻译成简体中文，严格按此格式输出两行：\n标题：<译题>\n正文：<译文>\n只输出译文，不要解释。',
          prompt: `标题：${item.title}\n\n正文：${item.summary || item.title}`,
          maxTokens: 1200,
          signal: AbortSignal.any([AbortSignal.timeout(opts.llmTimeoutMs), ...(opts.signal ? [opts.signal] : [])]),
        })
        const m = text.match(/标题：\s*([^\n]+)\n+(?:[\s\S]*?)正文：\s*([\s\S]+)/)
        item.state.translation = m ? `${m[1].trim()}\n\n${m[2].trim()}` : text.trim()
      } catch (e) {
        item.state.translationError = e instanceof Error ? e.message : String(e)
      }
    }
  })
  await Promise.all(workers)
}

/** 逐条一句话摘要：并发受限、单条失败只写 aiSummaryError 不丢条目；summarize=false 的源跳过（用 feed 原摘要）。 */
async function itemSummaries(
  items: FeedItem[],
  sourcesById: ReadonlyMap<string, { title: string; summarize: boolean }>,
  client: LlmClient,
  opts: DigestPipelineOptions,
): Promise<void> {
  const targets = items.filter((i) => sourcesById.get(i.sourceId)?.summarize !== false).slice(0, opts.summaryMaxItems)
  const queue = [...targets]
  let done = 0
  const workers = Array.from({ length: Math.max(1, opts.summaryConcurrency) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      try {
        const r = await summarize(
          {
            items: [toSummarizable(item, sourcesById.get(item.sourceId)?.title ?? item.sourceId)],
            language: opts.language,
            mode: 'single',
            maxLength: opts.summaryMaxLength,
            maxTokens: opts.llmMaxTokens,
            signal: AbortSignal.any([AbortSignal.timeout(opts.llmTimeoutMs), ...(opts.signal ? [opts.signal] : [])]),
          },
          client,
          true,
        )
        if (r.source === 'llm') item.aiSummary = r.text
        else item.aiSummaryError = r.error || 'extractive fallback'
      } catch (e) {
        item.aiSummaryError = e instanceof Error ? e.message : String(e)
      }
      done += 1
      opts.onItemDone?.(done, targets.length)
    }
  })
  await Promise.all(workers)
}

/** 生成并落盘当日日报；返回 DigestDocument（含 degraded/note 元数据）。 */
export async function runDailyDigest(opts: DigestPipelineOptions): Promise<DigestDocument> {
  const log = opts.log || noopLog
  const now = opts.now ?? new Date()
  const day = zonedDayKey(now, opts.timezone || undefined)
  const sources = effectiveSources(opts.configSources, opts.store)
  const sourcesById = new Map(sources.map((s) => [s.id, s]))

  // 候选池：今日未推过 + 未隐藏；candidateHours>0 时限近 N 小时
  const cutoff = (opts.candidateHours ?? 0) > 0 ? now.getTime() - opts.candidateHours! * 3600e3 : 0
  const candidates = opts.store.items.filter((i) =>
    (opts.force || i.digestedDay !== day) && !i.state.hidden
    && (!cutoff || new Date(i.fetchedAt).getTime() >= cutoff),
  )
  const picked = scoreAndSelect(candidates, sourcesById, opts.digestItems, {
    prefs: opts.prefs,
    digestDay: day,
    now,
    perTopicLimit: opts.perTopicLimit,
    penaltyWindowDays: opts.penaltyWindowDays,
  })

  // 逐条摘要（仅当有可用 LLM）；summarize=false 的源在 itemSummaries 内跳过
  if (opts.summaryEnabled && opts.llmEnabled && opts.llmClient) {
    await itemSummaries(picked, sourcesById, opts.llmClient, opts)
  }
  // 英文条目生成中英对照译文（翻译模型/缺省跟随摘要模型）
  if (opts.llmEnabled && opts.translateClient) {
    await translateItems(picked, opts.translateClient, opts)
  }

  // 整体总结（summarize 内部已含抽取降级）
  const summaryItems = picked.map((i) => toSummarizable(i, sourcesById.get(i.sourceId)?.title ?? i.sourceId))
  const sum = await summarize(
    {
      items: summaryItems, language: opts.language, mode: 'batch',
      maxLength: opts.digestMaxLength,
      maxTokens: opts.llmMaxTokens,
      signal: AbortSignal.any([AbortSignal.timeout(opts.llmTimeoutMs), ...(opts.signal ? [opts.signal] : [])]),
    },
    opts.llmClient,
    opts.llmEnabled && !!opts.llmClient,
  )

  // 源状态行：失败/冷却的源点名
  const failed = sources.filter((s) => s.health.lastError)
  const cooling = sources.filter((s) => s.health.cooldownUntil && new Date(s.health.cooldownUntil).getTime() > now.getTime()).length
  const statusLines = [`采集源状态：${sources.filter((s) => s.enabled).length}/${sources.length} 源 · ${opts.store.items.length} 条 · ${failed.length ? `${failed.length} 源异常${cooling ? `（${cooling} 冷却中）` : ''}` : '健康'}`]

  const degraded = sum.source !== 'llm'
  const note = degraded ? `summary degraded: ${sum.error ?? 'llm unavailable'}` : ''

  // 幂等保护：非 force 重跑若选出 0 条且当日已有日报，不覆盖旧文件
  const file = join(opts.digestsDir, digestFileName(day, opts.language))
  if (picked.length === 0 && !opts.force) {
    try {
      await access(file)
      const markdown = await readFile(file, 'utf8')
      // 同步 meta 防重启后 catch-up 反复白跑（digest-pipeline.ts:154 早退）
      opts.store.meta.lastDigestDay = day
      opts.store.meta.lastDigestAt = now.toISOString()
      await opts.store.save()
      log.warn(`digest ${day}: 0 candidates; kept existing digest file`)
      return { title: `RSS 简报 · ${day}`, date: day, language: opts.language, markdown, itemCount: 0, itemIds: [], summarySource: sum.source, degraded: true, note: 'no candidates; kept existing digest' }
    } catch { /* no existing file — fall through and write empty digest */ }
  }

  const markdown = renderDigest({
    date: day,
    language: opts.language,
    sourceTitles: new Map(sources.map((s) => [s.id, s.title])),
    items: picked,
    summaryText: sum.text,
    includeItemLinks: true,
    sourcesStatus: statusLines,
    degradedNote: degraded ? note.replace('summary degraded: ', '') : undefined,
  })

  await mkdir(opts.digestsDir, { recursive: true })
  await writeFile(file, markdown, 'utf8')

  opts.store.markDigested(picked.map((i) => i.id), day)
  opts.store.meta.lastDigestDay = day
  opts.store.meta.lastDigestAt = now.toISOString()
  await opts.store.save()

  // digests/index.json：历史日报索引（§4 契约，供 API/外部列历史）
  const indexFile = join(opts.digestsDir, 'index.json')
  let index: Array<{ date: string; items: number; degraded: boolean; note: string }> = []
  try { index = JSON.parse(await readFile(indexFile, 'utf8')) } catch { /* first run */ }
  const entry = { date: day, items: picked.length, degraded, note }
  const i = index.findIndex((e) => e.date === day)
  if (i >= 0) index[i] = entry
  else index.push(entry)
  index.sort((a, b) => b.date.localeCompare(a.date))
  await writeFile(indexFile, JSON.stringify(index.slice(0, 90), null, 2), 'utf8')

  log.info(`digest ${day}: ${picked.length} items, summary=${sum.source}${note ? ` (${note})` : ''} -> ${file}`)

  return {
    title: `RSS 简报 · ${day}`,
    date: day,
    language: opts.language,
    markdown,
    itemCount: picked.length,
    itemIds: picked.map((i) => i.id),
    summarySource: sum.source,
    degraded,
    note,
    tokens: (() => { const u = (opts.llmClient as { usage?: { inputTokens: number; outputTokens: number } } | undefined)?.usage; return u && (u.inputTokens + u.outputTokens) > 0 ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens } : undefined })(),
  }
}
