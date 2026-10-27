/**
 * Local JSON persistence for sources, items, and metadata.
 *
 * - Single JSON document, written atomically (temp file + rename) to survive
 *   process kills.
 * - Versioned schema with a defensive migration hook (nothing to migrate at
 *   schema 1, but future formats land here).
 * - Corrupted documents are quarantined (renamed aside) instead of being
 *   silently deleted, and a fresh store starts in their place.
 *
 * Pure module: node:fs / node:path only, no dsh dependency.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { FeedItem, FeedSource, LogSink } from './types.js'
import { noopLog } from './types.js'

export const STORE_SCHEMA = 1

export interface StoreMeta {
  /** ISO timestamp of the latest successful fetch cycle. */
  lastFetchAt: string
  /** ISO timestamp of the latest digest generation. */
  lastDigestAt: string
  /** Date key (YYYY-MM-DD in the digest timezone) of the latest digest. */
  lastDigestDay: string
}

export interface StoreData {
  schema: number
  meta: StoreMeta
  sources: FeedSource[]
  items: FeedItem[]
  /** 全源健康度表（含纯内置源）：key=normalizeUrl(url) */
  health: Record<string, FeedSource['health']>
}

const EMPTY_META: StoreMeta = {
  lastFetchAt: '',
  lastDigestAt: '',
  lastDigestDay: '',
}

/** Safely normalize an unknown value into {@link StoreData}, or null. */
export function normalizeStoreData(value: unknown): StoreData | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.schema === 'number' && record.schema > STORE_SCHEMA) {
    // Written by a newer version; never downgrade or truncate it.
    return null
  }
  const sources = Array.isArray(record.sources)
    ? record.sources.filter(isSourceLike).map((source) => ({
      // 先展开保留扩展字段（category/tier/health/weight…），再归一化必填项
      ...(source as Record<string, unknown>),
      id: stringOf(source.id),
      url: stringOf(source.url),
      title: stringOf(source.title),
      enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
      addedAt: stringOf(source.addedAt),
    })).map((s) => sanitizeSource(s as Record<string, unknown>)) as unknown as FeedSource[]
    : []
  const items = Array.isArray(record.items)
    ? record.items.filter(isItemLike).map((item) => ({
      // 同上：保留 topic/score/reasons/state/aiSummary 等扩展字段
      ...(item as Record<string, unknown>),
      id: stringOf(item.id),
      sourceId: stringOf(item.sourceId),
      title: stringOf(item.title),
      link: stringOf(item.link),
      summary: stringOf(item.summary),
      content: stringOf(item.content),
      publishedAt: stringOf(item.publishedAt),
      fetchedAt: stringOf(item.fetchedAt),
      hash: stringOf(item.hash),
      digestedDay: stringOf(item.digestedDay),
    })).map((i) => sanitizeItem(i as Record<string, unknown>)) as unknown as FeedItem[]
    : []
  const meta = (typeof record.meta === 'object' && record.meta !== null
    ? record.meta
    : {}) as Record<string, unknown>
  const health = (typeof record.health === 'object' && record.health !== null
    ? record.health
    : {}) as StoreData['health']
  return {
    schema: STORE_SCHEMA,
    meta: {
      lastFetchAt: typeof meta.lastFetchAt === 'string' ? meta.lastFetchAt : '',
      lastDigestAt: typeof meta.lastDigestAt === 'string' ? meta.lastDigestAt : '',
      lastDigestDay: typeof meta.lastDigestDay === 'string' ? meta.lastDigestDay : '',
    },
    sources,
    items,
    health,
  }
}

/** spread 保留扩展字段后，对已知类型字段做消毒——防手写坏数据在运行期崩掉（如 health:5） */
export function sanitizeSource(s: Record<string, unknown>): Record<string, unknown> {
  if (typeof s.health !== 'object' || s.health === null) {
    s.health = { ok: 0, fail: 0, failStreak: 0 }
  }
  const h = s.health as Record<string, unknown>
  h.ok = typeof h.ok === 'number' ? h.ok : 0
  h.fail = typeof h.fail === 'number' ? h.fail : 0
  h.failStreak = typeof h.failStreak === 'number' ? h.failStreak : 0
  s.weight = typeof s.weight === 'number' ? s.weight : 1
  s.tier = s.tier === 1 || s.tier === 2 || s.tier === 3 ? s.tier : 3
  return s
}

/** 同上，条目侧：state/reasons/score 畸形时回默认。 */
export function sanitizeItem(it: Record<string, unknown>): Record<string, unknown> {
  if (typeof it.state !== 'object' || it.state === null) {
    it.state = { read: false, hidden: false, liked: 0 }
  }
  const st = it.state as Record<string, unknown>
  st.read = st.read === true
  st.hidden = st.hidden === true
  st.liked = st.liked === 1 || st.liked === -1 ? st.liked : 0
  if (!Array.isArray(it.reasons)) it.reasons = []
  it.score = typeof it.score === 'number' ? it.score : 0
  return it
}

/** Minimal structural guard: a source-like entry carries a string url. */
function isSourceLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).url === 'string'
}

/** Minimal structural guard: an item-like entry carries a string id. */
function isItemLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).id === 'string'
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export interface StoreOptions {
  /** File path of the JSON store. */
  path: string
  /** Maximum number of items kept (oldest fetched are pruned on save). */
  maxItems?: number
  log?: LogSink
}

/**
 * In-memory working copy of the store document with persisted side effects.
 * Mutation methods update memory; persistence happens on {@link save}.
 */
export class Store {
  readonly path: string
  readonly maxItems: number
  private readonly log: LogSink
  private data: StoreData
  private dirty = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: StoreOptions) {
    this.path = options.path
    this.maxItems = options.maxItems ?? 1000
    this.log = options.log ?? noopLog
    this.data = {
      schema: STORE_SCHEMA,
      meta: { ...EMPTY_META },
      sources: [],
      items: [],
      health: {},
    }
  }

  get meta(): StoreMeta {
    return this.data.meta
  }

  get sources(): FeedSource[] {
    return this.data.sources
  }

  get items(): FeedItem[] {
    return this.data.items
  }

  /** 全源健康度表（含纯内置源），直接改引用后需 save() 持久化。 */
  get health(): StoreData['health'] {
    return this.data.health
  }

  /** 写某源健康度并标脏（fetchOne 每轮调用）。 */
  setHealth(id: string, health: FeedSource['health']): void {
    this.data.health[id] = { ...health }
    this.dirty = true
  }

  getHealth(id: string): FeedSource['health'] | undefined {
    return this.data.health[id]
  }

  /** Load the document from disk; missing/corrupt files start empty. */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) {
        this.log.info(`store not found at ${this.path}; starting empty`)
      } else {
        this.log.warn(`store unreadable at ${this.path}: ${messageOf(error)}`)
      }
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      await this.quarantine(raw)
      this.log.warn(`store at ${this.path} is corrupt (${messageOf(error)}); it was moved aside and a fresh store will be used`)
      return
    }
    const normalized = normalizeStoreData(parsed)
    if (normalized === null) {
      await this.quarantine(raw)
      this.log.warn(`store at ${this.path} has an unknown schema; it was moved aside and a fresh store will be used`)
      return
    }
    this.data = normalized
    this.log.info(`store loaded: ${this.data.sources.length} sources, ${this.data.items.length} items`)
  }

  /** Persist the in-memory state atomically. Never throws. */
  async save(): Promise<void> {
    this.prune()
    this.dirty = true
    const snapshot = JSON.stringify(this.data, null, 2)
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true })
        const tmp = `${this.path}.tmp`
        await writeFile(tmp, snapshot, 'utf8')
        await rename(tmp, this.path)
      } catch (error) {
        this.log.warn(`failed to persist store at ${this.path}: ${messageOf(error)}`)
      }
    })
    return this.writeQueue
  }

  /** Enforce the item retention cap (oldest fetched items are dropped). */
  private prune(): void {
    if (this.data.items.length <= this.maxItems) return
    const sorted = [...this.data.items].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))
    const kept = sorted.slice(sorted.length - this.maxItems)
    this.data.items = kept
    this.log.info(`pruned ${sorted.length - this.maxItems} oldest items (cap ${this.maxItems})`)
  }

  /** Rename a corrupt file aside so the original is moved, not copied. */
  private async quarantine(raw: string): Promise<void> {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const nonce = Math.random().toString(36).slice(2, 8)
      const target = `${this.path}.corrupt-${stamp}-${nonce}`
      try {
        await rename(this.path, target)
      } catch {
        // Rename may fail across devices or on locked files; fall back to a
        // copy so the bytes are still preserved, then clear the original.
        await writeFile(target, raw, 'utf8')
        await writeFile(this.path, '', 'utf8').catch(() => {})
      }
    } catch {
      // Quarantine is best-effort only.
    }
  }

  // ---- sources ----

  addSource(source: FeedSource): void {
    this.data.sources.push(source)
  }

  removeSource(id: string): boolean {
    const index = this.data.sources.findIndex((source) => source.id === id)
    if (index < 0) return false
    this.data.sources.splice(index, 1)
    this.data.items = this.data.items.filter((item) => item.sourceId !== id)
    return true
  }

  /** Append items not yet present by id, marking duplicates by identity. */
  addItems(items: FeedItem[]): number {
    const known = new Set(this.data.items.map((item) => item.id))
    let added = 0
    for (const item of items) {
      if (known.has(item.id)) continue
      known.add(item.id)
      this.data.items.push(item)
      added += 1
    }
    return added
  }

  /** Mark digest inclusion: set digestedDay for the given item ids. */
  markDigested(ids: string[], day: string): void {
    const wanted = new Set(ids)
    for (const item of this.data.items) {
      if (wanted.has(item.id)) item.digestedDay = day
    }
  }

  /** Count items whose digestedDay differs from `day` (candidates for digest). */
  countUndigested(day: string): number {
    return this.data.items.filter((item) => item.digestedDay !== day).length
  }
}

/** Items eligible for a digest with the given day key, newest first. */
export function undigestedItems(items: FeedItem[], day: string, limit: number): FeedItem[] {
  return items
    .filter((item) => item.digestedDay !== day)
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
    .slice(0, limit)
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ENOENT'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}