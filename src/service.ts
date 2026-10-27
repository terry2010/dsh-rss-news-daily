/**
 * FetchCycle：一轮"生效源表 → 并发抓取 → 解析 → 去重 → 入 store → 健康度"编排。
 *
 * 生效源表 = 内置目录(src/sources.builtin.json) ∪ config.sources ∪ store 用户源，
 * 按规范化 URL 去重（用户条目覆盖内置同名源，见 SOURCES.md §1）。
 * 健康度：连续 3 次失败 → 24h 冷却跳过；不删源，可手动复活。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FeedItem, FeedSource, FetchCycleResult, LogSink, SourceFetchResult } from './core/types.js'
import { noopLog } from './core/types.js'
import { parseFeedDocument, stripHtml, truncateCodePoints } from './core/parser.js'
import { findDuplicate, itemHash } from './core/dedupe.js'
import type { Store } from './core/store.js'
import type { createFetcher } from './core/fetcher.js'

export interface FetchCycleOptions {
  fetch: ReturnType<typeof createFetcher>
  store: Store
  sources: FeedSource[]
  maxItemsPerSource: number
  storeContentChars: number
  concurrency: number
  dedupeThreshold: number
  log?: LogSink
  now?: () => Date
}

const HEALTH_FAIL_COOLDOWN_STREAK = 3
const COOLDOWN_MS = 24 * 60 * 60 * 1000

/** URL 规范化：去追踪参数（utm_、fbclid、gclid 等）与结尾斜杠（OPML/源去重共用） */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    const drop = [...u.searchParams.keys()].filter((k) => /^(utm_|fbclid|gclid|ref$|ref_src$)/i.test(k))
    for (const k of drop) u.searchParams.delete(k)
    u.hash = ''
    u.hostname = u.hostname.toLowerCase()
    u.pathname = u.pathname.replace(/\/+$/, '') || '/'
    return u.toString()
  } catch {
    return raw.trim()
  }
}

interface BuiltinEntry {
  name: string
  url: string
  category?: string
  tier?: number
  lang?: 'zh' | 'en'
  method?: string
  defaultEnabled?: boolean
}

let builtinCache: BuiltinEntry[] | null = null

function builtinCatalog(): BuiltinEntry[] {
  if (builtinCache) return builtinCache
  const file = join(fileURLToPath(new URL('.', import.meta.url)), 'sources.builtin.json')
  builtinCache = (JSON.parse(readFileSync(file, 'utf8')) as { sources: BuiltinEntry[] }).sources
  return builtinCache
}

function emptyHealth() {
  return { ok: 0, fail: 0, failStreak: 0 }
}

function sourceIdOf(url: string): string {
  return normalizeUrl(url)
}

function toFeedSource(raw: {
  url: string; title: string; category?: string; tier?: number; lang?: 'zh' | 'en'
  method?: string; enabled?: boolean; builtin?: boolean; addedAt?: string
}): FeedSource {
  return {
    id: sourceIdOf(raw.url),
    url: raw.url,
    title: raw.title,
    enabled: raw.enabled !== false,
    addedAt: raw.addedAt || new Date().toISOString(),
    category: raw.category || '科技',
    tier: (raw.tier === 1 || raw.tier === 2 || raw.tier === 3 ? raw.tier : 3) as 1 | 2 | 3,
    lang: raw.lang || 'en',
    method: raw.method || 'direct',
    builtin: raw.builtin === true,
    weight: 1,
    health: emptyHealth(),
  }
}

/** 生效源表：内置 ∪ config 预置 ∪ store 用户源，按规范化 URL 合并（用户覆盖内置）。 */
export function effectiveSources(
  configSources: Array<{ url: string; title?: string; category?: string; enabled?: boolean }>,
  store: Store,
): FeedSource[] {
  const byUrl = new Map<string, FeedSource>()
  for (const s of builtinCatalog()) {
    if (s.defaultEnabled === false) continue
    byUrl.set(normalizeUrl(s.url), toFeedSource({
      url: s.url, title: s.name, category: s.category, tier: s.tier,
      lang: s.lang, method: s.method, enabled: true, builtin: true,
    }))
  }
  for (const s of configSources) {
    if (!s?.url) continue
    const key = normalizeUrl(s.url)
    const prev = byUrl.get(key)
    byUrl.set(key, toFeedSource({
      url: s.url, title: s.title || prev?.title || s.url, category: s.category || prev?.category,
      tier: prev?.tier, lang: prev?.lang, enabled: s.enabled !== false,
      builtin: prev?.builtin,
    }))
  }
  // store 用户源：含运行时新增 + 对内置源的状态/健康度覆盖
  for (const s of store.sources) {
    const key = normalizeUrl(s.url)
    const prev = byUrl.get(key)
    if (prev && prev.builtin) {
      // 用户改过内置源：沿用内置元数据 + 用户状态/健康度
      byUrl.set(key, { ...prev, enabled: s.enabled, weight: s.weight ?? prev.weight, health: s.health || prev.health })
    } else {
      byUrl.set(key, { ...s, builtin: s.builtin === true, health: s.health || emptyHealth() })
    }
  }
  return [...byUrl.values()]
}

function inCooldown(src: FeedSource, now: Date): boolean {
  const until = src.health.cooldownUntil
  return !!until && new Date(until).getTime() > now.getTime()
}

function recordHealth(src: FeedSource, ok: boolean, ms: number, err: string | undefined, now: Date): void {
  const h = src.health
  const samples = Math.min(h.ok + h.fail, 9)
  h.avgMs = h.avgMs === undefined ? ms : (h.avgMs * samples + ms) / (samples + 1)
  if (ok) {
    h.ok += 1
    h.failStreak = 0
    delete h.lastError
    delete h.cooldownUntil
  } else {
    h.fail += 1
    h.failStreak += 1
    h.lastError = (err || 'unknown').slice(0, 200)
    if (h.failStreak >= HEALTH_FAIL_COOLDOWN_STREAK) {
      h.cooldownUntil = new Date(now.getTime() + COOLDOWN_MS).toISOString()
    }
  }
}

function toItem(source: FeedSource, p: ReturnType<typeof parseFeedDocument>['items'][number], now: Date, maxChars: number): FeedItem {
  return {
    id: p.id || p.link || `${source.id}#${p.title}`,
    sourceId: source.id,
    title: p.title,
    link: p.link,
    summary: truncateCodePoints(stripHtml(p.summary || ''), maxChars),
    content: truncateCodePoints(stripHtml(p.content || ''), maxChars),
    publishedAt: p.publishedAt || now.toISOString(),
    fetchedAt: now.toISOString(),
    hash: itemHash(p.title, p.summary || p.content, false),
    digestedDay: '',
    topic: source.category,
    score: 0,
    reasons: [],
    state: { read: false, hidden: false, liked: 0 },
  }
}

async function fetchOne(
  src: FeedSource,
  opts: FetchCycleOptions,
  now: Date,
): Promise<SourceFetchResult> {
  const t0 = performance.now()
  const res: SourceFetchResult = { sourceId: src.id, sourceUrl: src.url, fetched: 0, added: 0, duplicated: 0 }
  try {
    const doc = await opts.fetch(src.url)
    if ('error' in doc) throw new Error(doc.error)
    const feed = parseFeedDocument(doc.body)
    const seen = new Set(opts.store.items.map((i) => i.id))
    const known = opts.store.items.map((i) => ({ title: i.title, hash: i.hash }))
    const fresh: FeedItem[] = []
    for (const p of feed.items.slice(0, opts.maxItemsPerSource)) {
      const item = toItem(src, p, now, opts.storeContentChars)
      if (seen.has(item.id)
        || findDuplicate({ title: item.title, hash: item.hash }, known, {
          threshold: opts.dedupeThreshold, compareContent: false,
        })) { res.duplicated += 1; continue }
      seen.add(item.id); known.push({ title: item.title, hash: item.hash })
      fresh.push(item)
    }
    res.fetched = feed.items.length
    res.added = opts.store.addItems(fresh)
    recordHealth(src, true, performance.now() - t0, undefined, now)
    // 健康度写回 store 里的同名源（若存在）
    const stored = opts.store.sources.find((s) => normalizeUrl(s.url) === src.id)
    if (stored) stored.health = { ...src.health }
  } catch (e) {
    res.error = String((e as Error)?.message || e).slice(0, 200)
    recordHealth(src, false, performance.now() - t0, res.error, now)
    const stored = opts.store.sources.find((s) => normalizeUrl(s.url) === src.id)
    if (stored) stored.health = { ...src.health }
  }
  return res
}

/** 跑一轮抓取；单源失败就地标注不影响其它源（铁律 2）。 */
export async function runFetchCycle(opts: FetchCycleOptions): Promise<FetchCycleResult> {
  const log = opts.log || noopLog
  const now = (opts.now || (() => new Date()))()
  const result: FetchCycleResult = {
    startedAt: now.toISOString(),
    finishedAt: '',
    sources: [],
    totalFetched: 0,
    totalAdded: 0,
    errors: 0,
  }
  const active = opts.sources.filter((s) => s.enabled && !inCooldown(s, now))
  const skipped = opts.sources.length - active.length
  if (skipped > 0) log.info(`fetch cycle: ${skipped} source(s) disabled or in cooldown`)

  const queue = [...active]
  const workers = Array.from({ length: Math.max(1, opts.concurrency) }, async () => {
    for (;;) {
      const src = queue.shift()
      if (!src) return
      const r = await fetchOne(src, opts, now)
      result.sources.push(r)
      result.totalFetched += r.fetched
      result.totalAdded += r.added
      if (r.error) result.errors += 1
    }
  })
  await Promise.all(workers)
  result.finishedAt = new Date().toISOString()
  await opts.store.save()
  log.info(`fetch cycle done: ${result.totalAdded} added / ${result.totalFetched} fetched / ${result.errors} errors`)
  return result
}
