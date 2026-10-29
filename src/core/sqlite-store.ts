/**
 * SQLite 持久层（DESIGN-SQLITE.md）——Store 同签名实现，引擎 node:sqlite。
 * items getter 有界（最近 maxItems 条），跨窗口查询走 queryItems。
 * 所有条目变更写穿透；meta/sources/health 内存镜像 + save 落盘。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync, createWriteStream, createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { FeedItem, FeedSource } from './types.js'
import type { StoreMeta } from './store.js'
import type { LogSink } from './types.js'

const noopLog: LogSink = { info() {}, warn() {}, error() {} }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, sourceId TEXT NOT NULL, topic TEXT,
  title TEXT NOT NULL, link TEXT, summary TEXT, content TEXT,
  publishedAt TEXT, fetchedAt TEXT NOT NULL, digestedDay TEXT,
  score REAL, llmScore REAL, llmReason TEXT, aiTitle TEXT, aiSummary TEXT,
  dupOf TEXT, dupCount INTEGER, hotCycles INTEGER,
  tags TEXT, reasons TEXT, state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_fetched ON items(fetchedAt);
CREATE INDEX IF NOT EXISTS idx_items_published ON items(publishedAt);
CREATE INDEX IF NOT EXISTS idx_items_source ON items(sourceId);
CREATE INDEX IF NOT EXISTS idx_items_topic ON items(topic);
CREATE INDEX IF NOT EXISTS idx_items_digest ON items(digestedDay);
CREATE INDEX IF NOT EXISTS idx_items_llmscore ON items(llmScore);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, url TEXT UNIQUE, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`
const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, summary, content='items', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary); END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, summary) VALUES('delete', old.rowid, old.title, old.summary); END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, summary) VALUES('delete', old.rowid, old.title, old.summary);
  INSERT INTO items_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary); END;
`

type Row = Record<string, unknown>
const rowToItem = (r: Row): FeedItem => ({
  id: r.id as string, hash: r.hash as string, sourceId: r.sourceId as string, topic: (r.topic as string) ?? '',
  title: r.title as string, link: (r.link as string) ?? '', summary: (r.summary as string) ?? '',
  content: (r.content as string) ?? '', publishedAt: (r.publishedAt as string) ?? '',
  fetchedAt: r.fetchedAt as string, digestedDay: (r.digestedDay as string) ?? '',
  score: (r.score as number) ?? 0, llmScore: r.llmScore == null ? undefined : (r.llmScore as number),
  llmReason: r.llmReason == null ? undefined : (r.llmReason as string),
  aiTitle: r.aiTitle == null ? undefined : (r.aiTitle as string),
  aiSummary: r.aiSummary == null ? undefined : (r.aiSummary as string),
  dupOf: r.dupOf == null ? undefined : (r.dupOf as string),
  dupCount: r.dupCount == null ? undefined : (r.dupCount as number),
  hotCycles: r.hotCycles == null ? undefined : (r.hotCycles as number),
  tags: r.tags ? JSON.parse(r.tags as string) : undefined,
  reasons: r.reasons ? JSON.parse(r.reasons as string) : [],
  state: r.state ? JSON.parse(r.state as string) : { read: false, hidden: false, liked: 0 },
})
const itemToRow = (i: FeedItem): (string | number | null)[] => [
  i.id, i.hash, i.sourceId, i.topic ?? '', i.title, i.link ?? '', i.summary ?? '', i.content ?? '',
  i.publishedAt ?? '', i.fetchedAt, i.digestedDay ?? '', i.score ?? 0, i.llmScore ?? null, i.llmReason ?? null,
  i.aiTitle ?? null, i.aiSummary ?? null, i.dupOf ?? null, i.dupCount ?? null, i.hotCycles ?? null,
  i.tags ? JSON.stringify(i.tags) : null, i.reasons ? JSON.stringify(i.reasons) : null,
  JSON.stringify(i.state ?? {}),
]

export interface SqliteStoreOptions {
  path: string            // .db 路径
  maxItems?: number
  retentionDays?: () => number
  pruneLowQuality?: () => boolean
  fts?: boolean           // FTS5 可用（P1 探测结果）
  log?: LogSink
}
// === SECTION 1 END ===

/** node:sqlite + FTS5 探测（P1）：不可用/无 FTS5 返回 false → 调用方报错不降级 */
export function probeSqlite(): { ok: boolean; fts: boolean } {
  try {
    const d = new DatabaseSync(':memory:')
    let fts = false
    try {
      d.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')`)
      d.exec('DROP TABLE t')
      fts = true
    } catch { /* fts5 不可用 */ }
    d.close()
    return { ok: true, fts }
  } catch { return { ok: false, fts: false } }
}

export class SqliteStore {
  readonly path: string
  readonly maxItems: number
  private readonly log: LogSink
  private readonly retentionDays: () => number
  private readonly pruneLowQuality: () => boolean
  private readonly ftsEnabled: boolean
  private db!: DatabaseSync
  private metaObj: StoreMeta & { health?: Record<string, FeedSource['health']> } = { lastFetchAt: '', lastDigestAt: '', lastDigestDay: '' } as StoreMeta & { health?: Record<string, FeedSource['health']> }
  private srcList: FeedSource[] = []
  private window: FeedItem[] = [] // items getter 的有界窗口（最近 maxItems 条）

  constructor(options: SqliteStoreOptions) {
    this.path = options.path
    this.maxItems = options.maxItems ?? 1000
    this.retentionDays = options.retentionDays ?? (() => 0)
    this.pruneLowQuality = options.pruneLowQuality ?? (() => false)
    this.ftsEnabled = options.fts ?? true
    this.log = options.log ?? noopLog
  }

  async load(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true })
    // 老 JSON 归档（不迁移条目；sources 例外读入）
    const legacy = this.path.replace(/\.db$/, '.json')
    let legacySources: FeedSource[] = []
    if (!existsSync(this.path) && existsSync(legacy)) {
      try {
        const raw = JSON.parse((await import('node:fs')).readFileSync(legacy, 'utf8')) as { sources?: FeedSource[] }
        legacySources = raw.sources ?? []
      } catch { /* 解析失败也无妨——不迁移 */ }
      renameSync(legacy, `${legacy}.migrated`)
      this.log.info('legacy store.json archived to .migrated (items/meta not migrated)')
    }
    // 打开 + 完整性检查（P6：损坏→改名隔离+全新空库）
    try {
      this.db = new DatabaseSync(this.path)
      const ic = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined
      if (ic && ic.integrity_check !== 'ok') throw new Error(`integrity: ${ic.integrity_check}`)
    } catch (e) {
      this.log.warn(`db open/integrity failed (${e instanceof Error ? e.message : e}); isolating and starting fresh`)
      try { this.db?.close() } catch { /* 未打开 */ }
      if (existsSync(this.path)) renameSync(this.path, `${this.path}.corrupt-${Date.now()}`)
      this.db = new DatabaseSync(this.path)
    }
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec(SCHEMA)
    if (this.ftsEnabled) { try { this.db.exec(FTS) } catch (e) { this.log.warn(`fts schema failed: ${e instanceof Error ? e.message : e}`) } }
    // meta kv → 内存对象
    this.metaObj = { lastFetchAt: '', lastDigestAt: '', lastDigestDay: '' } as StoreMeta & { health?: Record<string, FeedSource['health']> }
    for (const r of this.db.prepare('SELECT key, value FROM meta').all() as Row[]) {
      try { Object.assign(this.metaObj, { [r.key as string]: JSON.parse(r.value as string) }) } catch { /* 坏值跳过 */ }
    }
    // sources 表 → 内存（老 json 的 sources 合并进来）
    const srcRows = this.db.prepare('SELECT data FROM sources').all() as Row[]
    this.srcList = srcRows.map((r) => JSON.parse(r.data as string) as FeedSource)
    for (const ls of legacySources) if (!this.srcList.find((s) => s.url === ls.url)) this.addSource(ls)
    this.refreshWindow()
    this.prune()
  }

  private refreshWindow(): void {
    this.window = (this.db.prepare('SELECT * FROM items ORDER BY fetchedAt DESC LIMIT ?').all(this.maxItems) as Row[]).map(rowToItem)
  }

  // ---- 公开契约（同 Store） ----
  get meta() { return this.metaObj }
  get sources() { return this.srcList }
  get items() { return this.window }
  get health() { return (this.metaObj.health ??= {}) }
  count(): number { return (this.db.prepare('SELECT COUNT(*) c FROM items').get() as { c: number }).c }

  setHealth(id: string, health: FeedSource['health']): void { this.health[id] = health }
  getHealth(id: string) { return this.health[id] }

  addSource(source: FeedSource): void {
    this.db.prepare('INSERT OR REPLACE INTO sources (id,url,data) VALUES (?,?,?)')
      .run(source.id, source.url, JSON.stringify(source))
    const i = this.srcList.findIndex((s) => s.id === source.id)
    if (i >= 0) this.srcList[i] = source; else this.srcList.push(source)
  }
  removeSource(id: string): boolean {
    this.db.prepare('DELETE FROM sources WHERE id=?').run(id)
    const i = this.srcList.findIndex((s) => s.id === id)
    if (i < 0) return false
    this.srcList.splice(i, 1); return true
  }

  addItems(items: FeedItem[]): number {
    const ins = this.db.prepare(`INSERT OR IGNORE INTO items
      (id,hash,sourceId,topic,title,link,summary,content,publishedAt,fetchedAt,digestedDay,score,llmScore,llmReason,aiTitle,aiSummary,dupOf,dupCount,hotCycles,tags,reasons,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    let added = 0
    this.db.exec('BEGIN')
    try {
      for (const i of items) { if ((ins.run(...itemToRow(i) as (string | number | null)[])).changes > 0) { this.window.unshift(i); added++ } }
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    if (this.window.length > this.maxItems) this.window.length = this.maxItems
    return added
  }

  markDigested(ids: string[], day: string): void {
    const u = this.db.prepare('UPDATE items SET digestedDay=? WHERE id=?')
    this.db.exec('BEGIN')
    try { for (const id of ids) u.run(day, id); this.db.exec('COMMIT') }
    catch (e) { this.db.exec('ROLLBACK'); throw e }
    for (const i of this.window) if (ids.includes(i.id)) i.digestedDay = day
  }
  countUndigested(day: string): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM items WHERE digestedDay != ?").get(day) as { c: number }).c
  }
  /** save：把窗口内条目回写 + meta/health 落 kv（写穿透已在各处做，save 兜底） */
  async save(): Promise<void> {
    const up = this.db.prepare(`UPDATE items SET topic=?,title=?,link=?,summary=?,content=?,publishedAt=?,digestedDay=?,score=?,llmScore=?,llmReason=?,aiTitle=?,aiSummary=?,dupOf=?,dupCount=?,hotCycles=?,tags=?,reasons=?,state=? WHERE id=?`)
    this.db.exec('BEGIN')
    try {
      for (const i of this.window) {
        const r = itemToRow(i)
        up.run(r[3], r[4], r[5], r[6], r[7], r[8], r[10], r[11], r[12], r[13], r[14], r[15], r[16], r[17], r[18], r[19], r[20], r[21], i.id)
      }
      const setMeta = this.db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)')
      for (const [k, v] of Object.entries(this.metaObj)) if (k !== 'health') setMeta.run(k, JSON.stringify(v))
      setMeta.run('health', JSON.stringify(this.metaObj.health ?? {}))
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    this.prune()
  }

  /** 清空全部条目（含 FTS 联动+内存窗口）；返回删除数 */
  clearItems(): number {
    const n = this.count()
    this.db.exec('DELETE FROM items')
    this.window = []
    return n
  }

  /** 清退：先过期后配额（低质优先 or 最老优先），SQL DELETE */
  private prune(): void {
    const days = this.retentionDays()
    if (days > 0) {
      const cutoff = new Date(Date.now() - days * 86400e3).toISOString()
      const r = this.db.prepare('DELETE FROM items WHERE fetchedAt < ?').run(cutoff)
      if (Number(r.changes) > 0) this.log.info(`pruned ${r.changes} expired items (>${days}d)`)
    }
    const over = this.count() - this.maxItems
    if (over <= 0) return
    let del: number
    if (this.pruneLowQuality()) {
      // 质量键=llmScore ?? min(10,score*8)，低质优先（NULL 视为中档 5）
      del = Number(this.db.prepare(`DELETE FROM items WHERE id IN (
        SELECT id FROM items ORDER BY COALESCE(llmScore, MIN(10, MAX(0, score*8)), 5) ASC, fetchedAt ASC LIMIT ?)`).run(over).changes)
    } else {
      del = Number(this.db.prepare('DELETE FROM items WHERE id IN (SELECT id FROM items ORDER BY fetchedAt ASC LIMIT ?)').run(over).changes)
    }
    this.log.info(`pruned ${del} items (cap ${this.maxItems}${this.pruneLowQuality() ? ', low-quality first' : ''})`)
    if (del > 0) this.refreshWindow()
  }

  /** 跨窗口查询（/items 下推）：filter+sort+FTS+分页全在 SQL */
  queryItems(opts: {
    day?: string; fetchedAfter?: string; fetchedBefore?: string; category?: string; source?: string; unread?: boolean; q?: string
    sort?: 'published' | 'fetched'; page?: number; pageSize?: number
  }): { total: number; items: FeedItem[] } {
    const where: string[] = ["json_extract(state,'$.hidden') IS NOT 1"]
    const args: unknown[] = []
    if (opts.day || opts.fetchedAfter) { where.push('fetchedAt >= ? AND fetchedAt <= ?'); args.push(opts.fetchedAfter || `${opts.day}T00:00:00`, opts.fetchedBefore || `${opts.day}T23:59:59.999Z`) }
    if (opts.category) { where.push('topic = ?'); args.push(opts.category) }
    if (opts.source) { where.push('sourceId LIKE ?'); args.push(`%${opts.source}%`) }
    if (opts.unread) { where.push("json_extract(state,'$.read') IS NOT 1") }
    let from = 'FROM items'
    if (opts.q) {
      if (this.ftsEnabled && opts.q.length >= 3) { from = 'FROM items_fts JOIN items ON items.rowid = items_fts.rowid'; where.push('items_fts MATCH ?'); args.push(`"${opts.q.replace(/"/g, '""')}"`) }
      else { where.push("(title LIKE ? OR summary LIKE ?)"); args.push(`%${opts.q}%`, `%${opts.q}%`) } // 短词(<trigram 最小3字符)走 LIKE
    }
    const key = opts.sort === 'fetched' ? 'fetchedAt' : "COALESCE(NULLIF(publishedAt,''),fetchedAt)"
    const page = Math.max(1, opts.page ?? 1), size = opts.pageSize ?? 50
    const total = (this.db.prepare(`SELECT COUNT(*) c ${from} WHERE ${where.join(' AND ')}`).get(...args as (string | number | null)[]) as { c: number }).c
    const rows = this.db.prepare(`SELECT items.* ${from} WHERE ${where.join(' AND ')} ORDER BY ${key} DESC LIMIT ? OFFSET ?`).all(...args as (string | number | null)[], size, (page - 1) * size) as Row[]
    return { total, items: rows.map(rowToItem) }
  }

  // ---- P7 导出/导入 ----
  /** NDJSON 流式导出：meta头 + items + sources + digests */
  async exportNdjson(file: string, digestsDir: string, scope: 'all' | 'items' | 'digests' = 'all'): Promise<number> {
    mkdirSync(dirname(file), { recursive: true })
    const w = createWriteStream(file)
    const write = (o: unknown) => new Promise<void>((res) => w.write(JSON.stringify(o) + '\n', () => res()))
    await write({ type: 'meta', schemaVersion: 1, exportedAt: new Date().toISOString() })
    let n = 0
    if (scope !== 'digests') {
      for (const r of this.db.prepare('SELECT * FROM items').iterate() as Iterable<Row>) { await write({ type: 'item', data: rowToItem(r) }); n++ }
      for (const s of this.srcList) await write({ type: 'source', data: s })
    }
    if (scope !== 'items') {
      const { readdirSync, readFileSync } = await import('node:fs')
      for (const f of readdirSync(digestsDir).filter((f) => f.endsWith('.md'))) {
        const day = f.split('-').slice(0, 3).join('-')
        const kind = f.includes('hourly') ? 'hourly' : 'daily'
        await write({ type: 'digest', day, kind, data: readFileSync(join(digestsDir, f), 'utf8') })
      }
    }
    await new Promise<void>((res) => w.end(() => res()))
    return n
  }

  /** NDJSON 导入：逐行 parse+merge 幂等 */
  async importNdjson(file: string, digestsDir: string): Promise<{ items: number; sources: number; digests: number }> {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    const ins = this.db.prepare(`INSERT OR IGNORE INTO items
      (id,hash,sourceId,topic,title,link,summary,content,publishedAt,fetchedAt,digestedDay,score,llmScore,llmReason,aiTitle,aiSummary,dupOf,dupCount,hotCycles,tags,reasons,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const counts = { items: 0, sources: 0, digests: 0 }
    const { writeFileSync, existsSync: ex } = await import('node:fs')
    this.db.exec('BEGIN')
    try {
      for await (const line of rl) {
        if (!line.trim()) continue
        const o = JSON.parse(line) as { type: string; day?: string; kind?: string; data: unknown }
        if (o.type === 'item') { if (ins.run(...itemToRow(o.data as FeedItem) as (string | number | null)[]).changes > 0) counts.items++ }
        else if (o.type === 'source') { const src = o.data as FeedSource; if (!this.srcList.find((x) => x.url === src.url)) { this.addSource(src); counts.sources++ } }
        else if (o.type === 'digest' && o.day) {
          mkdirSync(digestsDir, { recursive: true })
          const f = join(digestsDir, `${o.day}${o.kind === 'hourly' ? '-hourly' : '-rss-briefing'}.md`)
          if (!ex(f)) { writeFileSync(f, o.data as string); counts.digests++ }
        }
      }
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    this.refreshWindow()
    return counts
  }

  /** .db 快照（VACUUM INTO）——全量灾备 */
  snapshot(file: string): void {
    mkdirSync(dirname(file), { recursive: true })
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  }

  close(): void { try { this.db.close() } catch { /* 幂等 */ } }
}
// === SECTION 3 END ===
