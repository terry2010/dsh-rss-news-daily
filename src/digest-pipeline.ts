/**
 * 日报管线：候选 → 打分精选 → 逐条摘要（逐条降级）→ 整体总结（整段降级）
 * → 渲染落盘 → 标记已推 + meta.lastDigestDay。
 *
 * 铁律 2：任何一条/一段 LLM 失败只降级该处，日报永远产出。
 */

import { mkdir, writeFile } from 'node:fs/promises'
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

/** 逐条一句话摘要：并发受限、单条失败只写 aiSummaryError 不丢条目。 */
async function itemSummaries(
  items: FeedItem[],
  sourcesById: Map<string, string>,
  client: LlmClient,
  opts: DigestPipelineOptions,
): Promise<void> {
  const targets = items.slice(0, opts.summaryMaxItems)
  const queue = [...targets]
  const workers = Array.from({ length: Math.max(1, opts.summaryConcurrency) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      try {
        const r = await summarize(
          {
            items: [toSummarizable(item, sourcesById.get(item.sourceId) ?? item.sourceId)],
            language: opts.language,
            mode: 'single',
            maxLength: opts.summaryMaxLength,
            maxTokens: opts.llmMaxTokens,
            signal: AbortSignal.timeout(opts.llmTimeoutMs),
          },
          client,
          true,
        )
        if (r.source === 'llm') item.aiSummary = r.text
        else item.aiSummaryError = r.error || 'extractive fallback'
      } catch (e) {
        item.aiSummaryError = e instanceof Error ? e.message : String(e)
      }
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
    i.digestedDay !== day && !i.state.hidden
    && (!cutoff || new Date(i.fetchedAt).getTime() >= cutoff),
  )
  const picked = scoreAndSelect(candidates, sourcesById, opts.digestItems, {
    prefs: opts.prefs,
    digestDay: day,
    now,
    perTopicLimit: opts.perTopicLimit,
  })

  // 逐条摘要（仅当有可用 LLM）
  if (opts.summaryEnabled && opts.llmEnabled && opts.llmClient) {
    await itemSummaries(picked, new Map(sources.map((s) => [s.id, s.title])), opts.llmClient, opts)
  }

  // 整体总结（summarize 内部已含抽取降级）
  const summaryItems = picked.map((i) => toSummarizable(i, sourcesById.get(i.sourceId)?.title ?? i.sourceId))
  const sum = await summarize(
    {
      items: summaryItems, language: opts.language, mode: 'batch',
      maxLength: opts.digestMaxLength,
      maxTokens: opts.llmMaxTokens,
      signal: AbortSignal.timeout(opts.llmTimeoutMs),
    },
    opts.llmClient,
    opts.llmEnabled && !!opts.llmClient,
  )

  // 源状态行：失败/冷却的源点名
  const statusLines = sources
    .filter((s) => s.health.lastError || s.health.cooldownUntil)
    .map((s) => {
      const state = s.health.cooldownUntil ? `冷却中（至 ${s.health.cooldownUntil.slice(0, 16)}）` : '失败'
      return `- ${s.title}: ${state}${s.health.lastError ? ` — ${s.health.lastError}` : ''}`
    })

  const markdown = renderDigest({
    date: day,
    language: opts.language,
    sourceTitles: new Map(sources.map((s) => [s.id, s.title])),
    items: picked,
    summaryText: sum.text,
    includeItemLinks: true,
    sourcesStatus: statusLines,
  })

  await mkdir(opts.digestsDir, { recursive: true })
  const file = join(opts.digestsDir, digestFileName(day, opts.language))
  await writeFile(file, markdown, 'utf8')

  opts.store.markDigested(picked.map((i) => i.id), day)
  opts.store.meta.lastDigestDay = day
  opts.store.meta.lastDigestAt = now.toISOString()
  await opts.store.save()

  const degraded = sum.source !== 'llm'
  const note = degraded ? `summary degraded: ${sum.error ?? 'llm unavailable'}` : ''
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
  }
}
