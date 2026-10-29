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
import type { StoreLike } from './core/store.js'
import type { createFetcher } from './core/fetcher.js'

export interface FetchCycleOptions {
  /** 手动抓取：绕过 24h 冷却重试失败源（调度路径不传） */
  force?: boolean
  /** 中止信号：取消后 worker 不再领取新源（在飞的抓完收尾） */
  signal?: AbortSignal
  /** 每完成一个源回调一次（进度上报） */
  onSourceStart?: (src: { url: string }) => void
  onSourceDone?: () => void
  fetch: ReturnType<typeof createFetcher>
  store: StoreLike
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
  method?: string; enabled?: boolean; builtin?: boolean; addedAt?: string; summarize?: boolean; proxy?: string | boolean; cooldownHours?: number
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
    proxy: raw.proxy,
    cooldownHours: raw.cooldownHours,
    health: emptyHealth(),
  }
}

/** 生效源表：内置 ∪ config 预置 ∪ store 用户源，按规范化 URL 合并（用户覆盖内置）。 */
export function effectiveSources(
  configSources: Array<{ url: string; title?: string; category?: string; enabled?: boolean; summarize?: boolean; proxy?: string | boolean; cooldownHours?: number }>,
  store: StoreLike,
): FeedSource[] {
  const byUrl = new Map<string, FeedSource>()
  const tomb = new Set((store.meta.deletedBuiltin || []).map(normalizeUrl)) // 用户删过的内置源
  for (const s of builtinCatalog()) {
    if (s.defaultEnabled === false || tomb.has(normalizeUrl(s.url))) continue
    byUrl.set(normalizeUrl(s.url), toFeedSource({
      url: s.url, title: s.name, category: s.category, tier: s.tier,
      lang: s.lang, method: s.method, enabled: true, builtin: true,
    }))
  }
  for (const s of configSources) {
    if (!s?.url) continue
    const key = normalizeUrl(s.url)
    if (tomb.has(key)) continue
    const prev = byUrl.get(key)
    byUrl.set(key, toFeedSource({
      url: s.url, title: s.title || prev?.title || s.url, category: s.category || prev?.category,
      tier: prev?.tier, lang: prev?.lang, enabled: s.enabled !== false,
      builtin: prev?.builtin, summarize: s.summarize !== false,
      proxy: s.proxy, cooldownHours: s.cooldownHours,
    }))
  }
  // store 用户源：含运行时新增 + 对内置源的状态/改名覆盖（改名以用户为准）
  for (const s of store.sources) {
    const key = normalizeUrl(s.url)
    const prev = byUrl.get(key)
    if (prev && prev.builtin) {
      byUrl.set(key, { ...prev, title: s.title || prev.title, enabled: s.enabled, weight: s.weight ?? prev.weight, summarize: s.summarize ?? prev.summarize, proxy: s.proxy ?? prev.proxy, cooldownHours: s.cooldownHours ?? prev.cooldownHours })
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
    // 错误文本消毒：真 HTML 拦页才剥标签（以 < 开头或 >=3 个标签），
    // 保留 "document root <html>" 这类解析错误里的标签名
    const rawErr = err || 'unknown'
    // 含闭合标签或以 < 开头才算真 HTML 拦页；"document root <html>" 这类解析错误保留标签名
    h.lastError = (/<\/[a-zA-Z]+>/i.test(rawErr) || rawErr.trimStart().startsWith('<')
      ? rawErr.replace(/<[^>]+>/g, ' ') : rawErr).replace(/\s+/g, ' ').trim().slice(0, 200)
    if (h.failStreak >= HEALTH_FAIL_COOLDOWN_STREAK) {
      h.cooldownUntil = new Date(now.getTime() + (src.cooldownHours ? src.cooldownHours * 3600e3 : COOLDOWN_MS)).toISOString()
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
    const doc = await opts.fetch(src.url, undefined, { proxy: src.proxy })
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
  store: StoreLike,
  opts: AddSourceOptions,
  classify?: (feed: { title: string; items: { title: string }[] }) => Promise<string>,
): Promise<FeedSource> {
  const url = opts.url.trim()
  if (!url) throw new Error('url required')
  if (store.sources.some((s) => normalizeUrl(s.url) === normalizeUrl(url))) {
    throw new Error(`已存在该源: ${url}`)
  }
  let doc = await fetch(url) // SSRF/超时/大小在 fetcher 内兜底
  let viaProxy = false
  if ('error' in doc) { // 直连失败 → 走全局代理重试（GFW 源：reddit/twitter 等）
    const proxied = await fetch(url, undefined, { proxy: true })
    if (!('error' in proxied)) { doc = proxied; viaProxy = true }
  }
  if ('error' in doc) throw new Error(`抓取失败: ${doc.error}`)
  const feed = parseFeedDocument(doc.body) // 解析失败会抛 FeedParseError
  if (feed.items.length === 0) throw new Error('feed 无条目（可能不是有效 RSS/Atom）')
  const category = opts.category || (classify ? await classify(feed) : '') || undefined
  const src = toFeedSource({
    url, title: opts.title || feed.title || url, category,
    builtin: false, proxy: viaProxy ? true : undefined,
  })
  store.addSource(src)
  store.setHealth(src.id, { ok: 1, fail: 0, failStreak: 0 }) // 校验抓取本身算一次成功
  await store.save()
  return src
}

/** 移除源（连带其条目）并落盘。内置源只支持停用不支持删除——停用走 store 覆盖层。 */
export async function restoreBuiltinSource(store: StoreLike, url: string): Promise<boolean> {
  const list = store.meta.deletedBuiltin || []
  const i = list.indexOf(normalizeUrl(url))
  if (i < 0) return false
  list.splice(i, 1)
  await store.save()
  return true
}

export async function removeSource(store: StoreLike, urlOrId: string, isBuiltin = false): Promise<boolean> {
  if (isBuiltin) { // 内置源→墓碑:不从 store 删,记 deletedBuiltin 让 effectiveSources 跳过
    const list = store.meta.deletedBuiltin || (store.meta.deletedBuiltin = [])
    if (!list.includes(normalizeUrl(urlOrId))) list.push(normalizeUrl(urlOrId))
    // 顺带清掉该源的覆盖层(改名/状态),恢复时回到出厂设置
    const i = store.sources.findIndex((s) => normalizeUrl(s.url) === normalizeUrl(urlOrId))
    if (i >= 0) store.sources.splice(i, 1)
    await store.save()
    return true
  }
  const id = normalizeUrl(urlOrId)
  const removed = store.removeSource(id) || store.removeSource(urlOrId)
  if (removed) await store.save()
  return removed
}

/** 启用/停用源：内置源在 store 写覆盖层，用户源直接改记录。
 *  builtinMeta 不传时自动查内置目录，防显示名退化为 URL。 */
export async function setSourceEnabled(
  store: StoreLike,
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
/** 更新源的任意可编辑属性（title/category/proxy/cooldownHours 走 override；enabled/summarize 由专门开关管，但这里一并兜住）。 */
export async function updateSource(store: StoreLike, urlOrId: string, patch: {
  title?: string; category?: string; enabled?: boolean; summarize?: boolean
  proxy?: string | boolean | null; cooldownHours?: number | null; url?: string
}, currentEnabled = true): Promise<void> {
  const id = normalizeUrl(urlOrId)
  const builtin = builtinCatalog().find((s) => normalizeUrl(s.url) === id)
    ?? builtinCatalog().find((s) => s.url === urlOrId)
  const existing = store.sources.find((s) => s.id === id || normalizeUrl(s.url) === id)
  const newUrl = typeof patch.url === 'string' && patch.url ? patch.url : undefined
  const newId = newUrl ? normalizeUrl(newUrl) : undefined
  if (existing) {
    if (newUrl && newId !== existing.id) { // 改 URL=改身份：id 重算 + 健康表迁移到新 id
      const h = store.getHealth(existing.id)
      if (h) store.setHealth(newId!, h)
      existing.url = newUrl; existing.id = newId!
    }
    if (patch.title !== undefined) existing.title = patch.title
    if (patch.category !== undefined) existing.category = patch.category
    if (patch.enabled !== undefined) existing.enabled = patch.enabled
    if (patch.summarize !== undefined) existing.summarize = patch.summarize
    if (patch.proxy !== undefined) (existing as { proxy?: string | boolean }).proxy = patch.proxy === null ? undefined : patch.proxy
    if (patch.cooldownHours !== undefined) (existing as { cooldownHours?: number }).cooldownHours = patch.cooldownHours === null ? undefined : patch.cooldownHours
  } else if (newUrl && builtin) {
    // 改内置源的 URL：旧 url 置停用（否则内置默认会再抓旧址）+ 新 url 落 override
    store.addSource(toFeedSource({ url: builtin.url, title: builtin.name, category: builtin.category, enabled: false }))
    store.addSource(toFeedSource({
      url: newUrl, title: patch.title || builtin.name, category: patch.category ?? builtin.category,
      enabled: patch.enabled ?? true, summarize: patch.summarize ?? true,
      proxy: patch.proxy === null ? undefined : patch.proxy, cooldownHours: patch.cooldownHours === null ? undefined : patch.cooldownHours,
    }))
  } else {
    store.addSource(toFeedSource({
      url: newUrl ?? urlOrId, title: patch.title || builtin?.name || newUrl || urlOrId, category: patch.category ?? builtin?.category,
      enabled: patch.enabled ?? currentEnabled, summarize: patch.summarize ?? true,
      proxy: patch.proxy === null ? undefined : patch.proxy, cooldownHours: patch.cooldownHours === null ? undefined : patch.cooldownHours,
    }))
  }
  await store.save()
}

export async function setSourceSummarize(store: StoreLike, urlOrId: string, summarize: boolean, currentEnabled = true): Promise<void> {
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
  store: StoreLike,
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
export async function exportOpml(store: StoreLike, configSources: Array<{ url: string; title?: string; category?: string; enabled?: boolean }>): Promise<string> {
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
  // force=手动抓取：绕过冷却把失败源也重试（调度/interval 不带 force，冷却照常生效）
  const active = opts.sources.filter((s) => s.enabled && (opts.force || !inCooldown(s, now)))
  const skipped = opts.sources.length - active.length
  if (skipped > 0) log.info(`fetch cycle: ${skipped} source(s) disabled or in cooldown`)

  const queue = [...active]
  const nowFn = opts.now || (() => new Date())
  const workers = Array.from({ length: Math.max(1, opts.concurrency) }, async () => {
    for (;;) {
      if (opts.signal?.aborted) return
      const src = queue.shift()
      if (!src) return
      opts.onSourceStart?.(src)
      const r = await fetchOne(src, opts, now)
      result.sources.push(r)
      result.totalFetched += r.fetched
      result.totalAdded += r.added
      if (r.error) result.errors += 1
      opts.onSourceDone?.()
    }
  })
  await Promise.all(workers)
  result.finishedAt = nowFn().toISOString()
  opts.store.meta.lastFetchAt = result.finishedAt
  opts.store.meta.lastFetchAdded = result.totalAdded
  await opts.store.save()
  log.info(`fetch cycle done: ${result.totalAdded} added / ${result.totalFetched} fetched / ${result.errors} errors`)
  return result
}
