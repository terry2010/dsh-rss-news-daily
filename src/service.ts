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
  /** 近似去重窗口（天）：仅对窗口内条目做 Jaccard；0=不限 */
  dedupeWindowDays?: number
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
  method?: string; enabled?: boolean; builtin?: boolean; addedAt?: string; summarize?: boolean
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
    summarize: raw.summarize !== false,
    health: emptyHealth(),
  }
}

/** 生效源表：内置 ∪ config 预置 ∪ store 用户源，按规范化 URL 合并（用户覆盖内置）。 */
export function effectiveSources(
  configSources: Array<{ url: string; title?: string; category?: string; enabled?: boolean; summarize?: boolean }>,
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
      builtin: prev?.builtin, summarize: s.summarize !== false,
    }))
  }
  // store 用户源：含运行时新增 + 对内置源的状态/改名覆盖（改名以用户为准）
  for (const s of store.sources) {
    const key = normalizeUrl(s.url)
    const prev = byUrl.get(key)
    if (prev && prev.builtin) {
      byUrl.set(key, { ...prev, title: s.title || prev.title, enabled: s.enabled, weight: s.weight ?? prev.weight, summarize: s.summarize ?? prev.summarize })
    } else {
      byUrl.set(key, { ...s, builtin: s.builtin === true })
    }
  }
  // 健康度统一从 store.health 表读（纯内置源也持久化；含畸形防御）
  for (const s of byUrl.values()) {
    const h = store.getHealth(s.id)
    s.health = h && typeof h === 'object' ? { ...h } : emptyHealth()
  }
  return [...byUrl.values()]
}

function inCooldown(src: FeedSource, now: Date): boolean {
  const until = src.health.cooldownUntil
  return !!until && new Date(until).getTime() > now.getTime()
}

function recordHealth(src: FeedSource, ok: boolean, ms: number, err: string | undefined, now: Date): void {
  if (!src.health || typeof src.health !== 'object') src.health = emptyHealth() // 畸形数据防御
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
    const seenHash = new Set(opts.store.items.map((i) => i.hash)) // exact-hash 全量，不随窗口
    const windowMs = (opts.dedupeWindowDays ?? 0) * 86400e3
    const cutoff = windowMs > 0 ? now.getTime() - windowMs : 0
    const known = opts.store.items
      .filter((i) => !cutoff || new Date(i.fetchedAt).getTime() >= cutoff)
      .map((i) => ({ title: i.title, hash: '' })) // 窗口内只做标题 Jaccard，exact 由 seenHash 管
    const fresh: FeedItem[] = []
    for (const p of feed.items.slice(0, opts.maxItemsPerSource)) {
      const item = toItem(src, p, now, opts.storeContentChars)
      if (seen.has(item.id) || seenHash.has(item.hash)
        || findDuplicate({ title: item.title, hash: '__never__' }, known, {
          threshold: opts.dedupeThreshold, compareContent: false,
        })) { res.duplicated += 1; continue }
      seen.add(item.id); seenHash.add(item.hash); known.push({ title: item.title, hash: '' })
      fresh.push(item)
    }
    res.fetched = feed.items.length
    res.added = opts.store.addItems(fresh)
    recordHealth(src, true, performance.now() - t0, undefined, now)
  } catch (e) {
    res.error = String((e as Error)?.message || e).slice(0, 200)
    recordHealth(src, false, performance.now() - t0, res.error, now)
  }
  // 健康度统一落 store.health 表（含纯内置源）
  try { opts.store.setHealth(src.id, src.health) } catch { /* 健康度写失败不拖垮本轮 */ }
  return res
}

// ---- 源管理（news_* 工具/API 共用） ----

export interface AddSourceOptions {
  url: string
  title?: string
  category?: string
}

/** 添加源：SSRF → 真实抓取校验 → 解析 feed 提标题 → 落 store。校验不过不保存。 */
export async function addSource(
  fetch: ReturnType<typeof createFetcher>,
  store: Store,
  opts: AddSourceOptions,
): Promise<FeedSource> {
  const url = opts.url.trim()
  if (!url) throw new Error('url required')
  if (store.sources.some((s) => normalizeUrl(s.url) === normalizeUrl(url))) {
    throw new Error(`已存在该源: ${url}`)
  }
  const doc = await fetch(url) // SSRF/超时/大小在 fetcher 内兜底
  if ('error' in doc) throw new Error(`抓取失败: ${doc.error}`)
  const feed = parseFeedDocument(doc.body) // 解析失败会抛 FeedParseError
  if (feed.items.length === 0) throw new Error('feed 无条目（可能不是有效 RSS/Atom）')
  const src = toFeedSource({
    url, title: opts.title || feed.title || url, category: opts.category,
    builtin: false,
  })
  store.addSource(src)
  await store.save()
  return src
}

/** 移除源（连带其条目）并落盘。内置源只支持停用不支持删除——停用走 store 覆盖层。 */
export async function removeSource(store: Store, urlOrId: string): Promise<boolean> {
  const id = normalizeUrl(urlOrId)
  const removed = store.removeSource(id) || store.removeSource(urlOrId)
  if (removed) await store.save()
  return removed
}

/** 启用/停用源：内置源在 store 写覆盖层，用户源直接改记录。
 *  builtinMeta 不传时自动查内置目录，防显示名退化为 URL。 */
export async function setSourceEnabled(
  store: Store,
  urlOrId: string,
  enabled: boolean,
  builtinMeta?: { title: string; category: string },
): Promise<void> {
  const id = normalizeUrl(urlOrId)
  const builtin = builtinCatalog().find((s) => normalizeUrl(s.url) === id)
    ?? builtinCatalog().find((s) => s.url === urlOrId)
  const metaTitle = builtinMeta?.title ?? builtin?.name
  const metaCategory = builtinMeta?.category ?? builtin?.category
  const existing = store.sources.find((s) => s.id === id || normalizeUrl(s.url) === id)
  if (existing) {
    existing.enabled = enabled
  } else {
    // 内置源停用：写一条覆盖层记录（builtin 标记由 effectiveSources 以 URL 命中内置后纠正）
    store.addSource(toFeedSource({
      url: urlOrId, title: metaTitle || urlOrId,
      category: metaCategory, enabled,
    }))
  }
  await store.save()
}

/** 切换源级 AI 摘要开关（summarize=false 的源，日报里用 feed 原摘要、不调 LLM）。
 *  currentEnabled 传当前生效 enabled——写覆盖层时保留，避免误复活被 config 停用的源。 */
export async function setSourceSummarize(store: Store, urlOrId: string, summarize: boolean, currentEnabled = true): Promise<void> {
  const id = normalizeUrl(urlOrId)
  const builtin = builtinCatalog().find((s) => normalizeUrl(s.url) === id)
    ?? builtinCatalog().find((s) => s.url === urlOrId)
  const existing = store.sources.find((s) => s.id === id || normalizeUrl(s.url) === id)
  if (existing) {
    existing.summarize = summarize
  } else {
    store.addSource(toFeedSource({
      url: urlOrId, title: builtin?.name || urlOrId,
      category: builtin?.category, enabled: currentEnabled, summarize,
    }))
  }
  await store.save()
}

export interface OpmlImportResult {
  added: number
  duplicated: number
  skipped: number
  details: Array<{ url: string; action: 'added' | 'duplicated' | 'skipped'; reason?: string }>
}

/** OPML 导入编排：规范化去重 + 判重（store∪builtin∪config），明细可核对。
 *  批量导入不做逐源抓取校验（数十源的串行校验太慢）——健康度由后续 fetch 循环接管。 */
export async function importOpml(
  store: Store,
  opmlText: string,
  configSources: Array<{ url: string }> = [],
): Promise<OpmlImportResult> {
  const { parseOpml } = await import('./core/opml.js')
  const entries = parseOpml(opmlText) // 非 OPML 抛错，调用方兜底
  const known = new Set([
    ...builtinCatalog().map((s) => normalizeUrl(s.url)),
    ...configSources.map((s) => normalizeUrl(s.url)),
    ...store.sources.map((s) => normalizeUrl(s.url)),
  ])
  const r: OpmlImportResult = { added: 0, duplicated: 0, skipped: 0, details: [] }
  for (const e of entries) {
    const key = normalizeUrl(e.xmlUrl)
    if (!e.xmlUrl || !/^https?:/i.test(e.xmlUrl)) {
      r.skipped++; r.details.push({ url: e.xmlUrl, action: 'skipped', reason: '非 http(s) URL' })
      continue
    }
    if (known.has(key)) {
      r.duplicated++; r.details.push({ url: e.xmlUrl, action: 'duplicated' })
      continue
    }
    known.add(key)
    store.addSource(toFeedSource({ url: e.xmlUrl, title: e.title, category: e.category }))
    r.added++; r.details.push({ url: e.xmlUrl, action: 'added' })
  }
  if (r.added > 0) await store.save()
  return r
}

/** OPML 导出：生效源表 → opml 文本。 */
export async function exportOpml(store: Store, configSources: Array<{ url: string; title?: string; category?: string; enabled?: boolean }>): Promise<string> {
  const { generateOpml } = await import('./core/opml.js')
  return generateOpml(
    effectiveSources(configSources, store)
      .filter((s) => s.enabled)
      .map((s) => ({ title: s.title, url: s.url, category: s.category })),
  )
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
  const nowFn = opts.now || (() => new Date())
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
  result.finishedAt = nowFn().toISOString()
  opts.store.meta.lastFetchAt = result.finishedAt
  await opts.store.save()
  log.info(`fetch cycle done: ${result.totalAdded} added / ${result.totalFetched} fetched / ${result.errors} errors`)
  return result
}
