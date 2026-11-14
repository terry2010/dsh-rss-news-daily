/**
 * SQLite 持久层（DESIGN-SQLITE.md）——Store 同签名实现，引擎 node:sqlite。
 * items getter 有界（最近 maxItems 条），跨窗口查询走 queryItems。
 * 所有条目变更写穿透；meta/sources/health 内存镜像 + save 落盘。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync, copyFileSync, rmSync, createWriteStream, createReadStream } from 'node:fs'
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

/** 同步 schema 纪元：结构性变更（加列/改表/数据回填）时 +1，并在 openDb 迁移段挂对应步骤。
    记录于 PRAGMA user_version——SQLite 内建槽位，不占 meta kv；跳版本升级按序连跑幂等收敛。 */
const SCHEMA_VERSION = 1
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
const ITEM_COLS = ['id','hash','sourceId','topic','title','link','summary','content','publishedAt','fetchedAt','digestedDay','score','llmScore','llmReason','aiTitle','aiSummary','dupOf','dupCount','hotCycles','tags','reasons','state'] as const

const itemToRow = (i: FeedItem): (string | number | null)[] => [
  i.id, i.hash, i.sourceId, i.topic ?? '', i.title, i.link ?? '', i.summary ?? '', i.content ?? '',
  i.publishedAt ?? '', i.fetchedAt, i.digestedDay ?? '', i.score ?? 0, i.llmScore ?? null, i.llmReason ?? null,
  i.aiTitle ?? null, i.aiSummary ?? null, i.dupOf ?? null, i.dupCount ?? null, i.hotCycles ?? null,
  i.tags ? JSON.stringify(i.tags) : null, i.reasons ? JSON.stringify(i.reasons) : null,
  JSON.stringify(i.state ?? {}),
]

export interface SqliteStoreOptions {
  path: string            // .db 路径
  /** 数量上限：数字或实时读取函数（偏好覆盖走后者，改设置即生效） */
  maxItems?: number | (() => number)
  retentionDays?: () => number
  pruneLowQuality?: () => boolean
  fts?: boolean           // FTS5 可用（P1 探测结果）
  isIdle?: () => boolean  // 全系统空闲判定（任务队列无在跑/等待）——每日 integrity_check 只在空闲跑
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
  private readonly maxItemsFn: () => number
  get maxItems(): number { return this.maxItemsFn() }
  private readonly log: LogSink
  private readonly retentionDays: () => number
  private readonly pruneLowQuality: () => boolean
  private readonly ftsEnabled: boolean
  private readonly isIdleFn: () => boolean
  private db!: DatabaseSync
  private metaObj: StoreMeta & { health?: Record<string, FeedSource['health']> } = { lastFetchAt: '', lastDigestAt: '', lastDigestDay: '' } as StoreMeta & { health?: Record<string, FeedSource['health']> }
  private srcList: FeedSource[] = []
  private window: FeedItem[] = [] // items getter 的有界窗口（最近 maxItems 条）
  private windowReady = false // 窗口是否已建——load() 后由 warmWindow 分块填充，就绪前 getter 走惰性同步兜底
  private windowGen = 0 // 窗口代际：refreshWindow/addItems/clearItems 自增——warmWindow 半成品据此判脏
  private dirtyItems = new Map<string, FeedItem>() // 自上次 save 以来被改过的条目（窗口 Proxy 脏标记）
  private proxyCache = new WeakMap<object, object>()

  /** 条目脏检测：窗口对象套 Proxy，任意层级写入（含 state.* 嵌套）都把根条目记入 dirtyItems——
      save() 只回写脏行。全窗口重写在万级条目库上是秒级事件循环阻塞（API 全卡）。 */
  private track<T>(value: T, mark: () => void): T {
    if (value === null || typeof value !== 'object') return value
    const hit = this.proxyCache.get(value as object)
    if (hit) return hit as T
    const proxy = new Proxy(value as object, {
      get: (target, key) => this.track(Reflect.get(target, key), mark),
      set: (target, key, v) => {
        const changed = !Object.is(Reflect.get(target, key), v)
        const ok = Reflect.set(target, key, v)
        if (ok && changed) mark()
        return ok
      },
      deleteProperty: (target, key) => {
        const ok = Reflect.deleteProperty(target, key)
        if (ok) mark()
        return ok
      },
    })
    this.proxyCache.set(value as object, proxy)
    return proxy as T
  }
  private wrapItem(item: FeedItem): FeedItem {
    return this.track(item, () => { this.dirtyItems.set(item.id, item) })
  }

  constructor(options: SqliteStoreOptions) {
    this.path = options.path
    const mi = options.maxItems
    this.maxItemsFn = typeof mi === 'function' ? mi : () => mi ?? 1000
    this.retentionDays = options.retentionDays ?? (() => 0)
    this.pruneLowQuality = options.pruneLowQuality ?? (() => false)
    this.ftsEnabled = options.fts ?? true
    this.isIdleFn = options.isIdle ?? (() => true)
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
    // 打开 + 轻量健全性探针：读系统目录首页——任何库都有此行，"文件不是库/页1损坏"立即抛；
    // SCHEMA 建表同包在探测里（坏库在建表阶段抛一样走隔离）。
    // 完整 integrity_check 不在启动路径跑：它同步全页扫描随库线性增长（314MB≈1.4s），
    // 同步执行会堵死事件循环——API 请求全部排队等它，表现为"进插件等几秒才出新闻"。
    // 完整校验推迟到 load() 后的空闲窗口（见 scheduleIntegrityCheck）。
    const openDb = () => {
      this.db = new DatabaseSync(this.path)
      this.db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()
      this.db.exec('PRAGMA journal_mode=WAL')
      // schema 纪元判定必须在 SCHEMA 建表前：存量库（有 items 表、无版本号）= v1 基线；
      // v>SCHEMA_VERSION=库比插件新（降级运行）：不动结构只告警——加法索引/列对老代码无害
      const v = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      const hadItems = !!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='items'").get()
      if (v === 0 && hadItems) this.db.exec('PRAGMA user_version = 1')
      if (v > SCHEMA_VERSION) this.log.warn(`db schema v${v} > plugin v${SCHEMA_VERSION}（降级运行）——不动结构`)
      // 未来非加法迁移在此按序挂步：if (v < 2) { ALTER/BACKFILL…; PRAGMA user_version = 2 }
      this.db.exec(SCHEMA)
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
    try {
      openDb()
    } catch (e) {
      this.log.warn(`db open/sanity failed (${e instanceof Error ? e.message : e}); isolating and starting fresh`)
      this.isolateCorrupt()
      openDb() // 新空库建表不会再坏——再坏是环境级问题，抛给 load() 外层处理
    }
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
    // 窗口分块异步预热：万级条目库全量 SELECT+JSON.parse+Proxy 是秒级事件循环阻塞，
    // 同步跑会把 mountApi 之后的所有请求按在队列里（表现为"进插件等几秒才出新闻"）。
    // 分块让事件循环喘气、请求穿插处理；load() 先兑现，窗口未就绪的访问走 items getter 惰性兜底。
    // 重建路径（restoreFrom/坏库隔离重载）会二次进 load()：旧窗口是上一个库的数据——先作废再预热。
    this.window = []
    this.windowReady = false
    this.windowGen++ // 同时作废可能在飞的上一轮 warmWindow 半成品
    // 启动不做清退（过期归档/超配额删除随 save() 生命周期走）——保库原样，大库冷启动不被二次阻塞
    void this.warmWindow()
      .catch((e) => this.log.warn(`window warm failed: ${e instanceof Error ? e.message : e}`))
    this.scheduleIntegrityCheck()
  }

  /** 坏库隔离：关句柄→改名存档→开全新空库（调用方随后重跑 load 建 schema+回填内存） */
  private isolateCorrupt(): void {
    try { this.db?.close() } catch { /* 未打开 */ }
    if (existsSync(this.path)) renameSync(this.path, `${this.path}.corrupt-${Date.now()}`)
    this.db = new DatabaseSync(this.path)
  }

  private icTimer: ReturnType<typeof setInterval> | undefined
  private lastIntegrityAt = 0
  /** integrity_check 节奏：每 30min 探一次——距上次 >24h 且全系统空闲（任务队列空 + 无页面心跳）
      才真正执行（全页扫随库线性增长，忙时/用户在用时跑会卡 API）。
      命中损坏走与启动探针同一隔离路径+重跑 load。 */
  private scheduleIntegrityCheck(): void {
    if (this.icTimer) clearInterval(this.icTimer) // restoreFrom/隔离重建都会再过 load()——只保留最新一个钟
    this.icTimer = setInterval(() => this.integrityTick(), 30 * 60_000)
    this.icTimer.unref?.()
  }
  private integrityTick(): void {
    const DAY = 24 * 3600_000
    if (Date.now() - this.lastIntegrityAt < DAY) return
    if (!this.isIdleFn()) return // 有任务在跑/排队——下次再探
    this.lastIntegrityAt = Date.now() // 先记账——即便失败也不每分钟重扫大库
    try {
      const ic = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined
      if (ic && ic.integrity_check !== 'ok') {
        this.log.error(`sqlite integrity_check failed: ${ic.integrity_check} — isolating corrupt db`)
        this.isolateCorrupt()
        void this.load().catch((e) => this.log.error(`reload after corrupt-isolate failed: ${e instanceof Error ? e.message : e}`))
      } else {
        this.log.info('sqlite integrity_check: ok')
      }
    } catch (e) { this.log.warn(`deferred integrity_check failed: ${e instanceof Error ? e.message : e}`) }
  }

  /** 热恢复：关库 → file 覆盖 store.db → 重新 load（meta/sources/窗口全部重建）。
      调用方须先停抓取/生成；脏窗口清空避免旧数据写回恢复库。 */
  async restoreFrom(file: string): Promise<void> {
    try { this.db.close() } catch { /* 幂等 */ }
    for (const ext of ['', '-wal', '-shm']) rmSync(`${this.path}${ext}`, { force: true })
    copyFileSync(file, this.path)
    this.dirtyItems.clear()
    this.proxyCache = new WeakMap()
    await this.load()
  }

  private refreshWindow(): void {
    // 不清 dirtyItems：窗口重建丢的是代理外壳，脏条目快照仍可回写（已删行 UPDATE 0 行无害，自清于下次 commit）
    this.window = (this.db.prepare('SELECT * FROM items ORDER BY fetchedAt DESC LIMIT ?').all(this.maxItems) as Row[]).map((r) => this.wrapItem(rowToItem(r)))
    this.windowReady = true
    this.windowGen++
  }
  /** 分块预热：LIMIT/OFFSET 分批取行+逐行包裹，块间 setImmediate 让渡——事件循环不被一坨同步工作堵死。
      预热期间有写入（addItems/refreshWindow/clearItems）→ 代际变了，半成品弃之改同步重建（正确性优先）。 */
  private async warmWindow(): Promise<void> {
    await new Promise((r) => setImmediate(r)) // 先让渡一拍：async 函数在首个 await 前是同步执行——没有这句建索引会跑回 load() 临界路径
    const gen0 = this.windowGen
    // 表达式索引后台建：升级后首次启动建索引是一次性秒级扫表——放预热期不堵 load() 就绪点；已存在则瞬时
    try { this.db.exec("CREATE INDEX IF NOT EXISTS idx_items_pubsort ON items(COALESCE(NULLIF(publishedAt,''),fetchedAt))") }
    catch (e) { this.log.warn(`pubsort index failed: ${e instanceof Error ? e.message : e}`) }
    const stmt = this.db.prepare('SELECT * FROM items ORDER BY fetchedAt DESC LIMIT ? OFFSET ?')
    const CHUNK = 1000
    const out: FeedItem[] = []
    for (let off = 0; off < this.maxItems; off += CHUNK) {
      if (this.windowReady) return // 有调用方等不及走了惰性同步兜底——半成品丢
      const rows = stmt.all(CHUNK, off) as Row[]
      for (const r of rows) out.push(this.wrapItem(rowToItem(r)))
      if (rows.length < CHUNK) break
      await new Promise((r) => setImmediate(r))
    }
    if (this.windowReady) return
    if (this.windowGen !== gen0) { this.refreshWindow(); return } // 预热期窗口被写过——半成品脏，同步重建保正确
    this.window = out
    this.windowReady = true
  }

  // ---- 公开契约（同 Store） ----
  get meta() { return this.metaObj }
  get sources() { return this.srcList }
  get items() {
    if (!this.windowReady) this.refreshWindow() // 惰性兜底：预热未完成时第一个真需要的调用方付一次同步价
    return this.window
  }
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
  removeItemsBySource(sourceId: string): number {
    const removed = Number(this.db.prepare('DELETE FROM items WHERE sourceId=?').run(sourceId).changes)
    if (removed > 0) this.refreshWindow()
    return removed
  }
  removeSource(id: string): boolean {
    const i = this.srcList.findIndex((s) => s.id === id)
    if (i < 0) return false
    this.db.exec('BEGIN')
    let removedItems = 0
    try {
      this.db.prepare('DELETE FROM sources WHERE id=?').run(id)
      removedItems = Number(this.db.prepare('DELETE FROM items WHERE sourceId=?').run(id).changes)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    if (removedItems > 0) this.refreshWindow()
    this.srcList.splice(i, 1); return true
  }

  addItems(items: FeedItem[]): number {
    const ins = this.db.prepare(`INSERT OR IGNORE INTO items
      (id,hash,sourceId,topic,title,link,summary,content,publishedAt,fetchedAt,digestedDay,score,llmScore,llmReason,aiTitle,aiSummary,dupOf,dupCount,hotCycles,tags,reasons,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const fresh: FeedItem[] = []
    this.db.exec('BEGIN')
    try {
      for (const i of items) { if ((ins.run(...itemToRow(i) as (string | number | null)[])).changes > 0) fresh.push(i) }
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    // 逐条 unshift 是 O(n·k)；反转后一次前插等价（每条 unshift 会把已插入项逆序压到队首）
    this.window.splice(0, 0, ...fresh.reverse().map((i) => this.wrapItem(i)))
    if (this.window.length > this.maxItems) this.window.length = this.maxItems
    this.windowGen++ // 窗口被写——warmWindow 半成品据此判脏重建
    return fresh.length
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
  /** save：脏条目回写 + meta/health 落 kv（写穿透已在各处做，save 兜底）。
      只 UPDATE 自上次 save 以来被改过的行——万级窗口全量重写会把事件循环堵秒级。 */
  async save(): Promise<void> {
    const dirtyItems = [...this.dirtyItems.values()]
    this.db.exec('BEGIN')
    try {
      if (dirtyItems.length) {
        const up = this.db.prepare(`UPDATE items SET topic=?,title=?,link=?,summary=?,content=?,publishedAt=?,digestedDay=?,score=?,llmScore=?,llmReason=?,aiTitle=?,aiSummary=?,dupOf=?,dupCount=?,hotCycles=?,tags=?,reasons=?,state=? WHERE id=?`)
        for (const i of dirtyItems) {
          const r = itemToRow(i)
          up.run(r[3], r[4], r[5], r[6], r[7], r[8], r[10], r[11], r[12], r[13], r[14], r[15], r[16], r[17], r[18], r[19], r[20], r[21], i.id)
        }
      }
      const setMeta = this.db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)')
      for (const [k, v] of Object.entries(this.metaObj)) if (k !== 'health') setMeta.run(k, JSON.stringify(v))
      setMeta.run('health', JSON.stringify(this.metaObj.health ?? {}))
      this.db.exec('COMMIT')
      this.dirtyItems.clear()
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    this.prune()
  }

  /** 清空全部条目（含 FTS 联动+内存窗口）；返回删除数 */
  clearItems(): number {
    const n = this.count()
    this.db.exec('DELETE FROM items')
    this.window = []
    this.windowGen++
    this.dirtyItems.clear()
    return n
  }

  /** 年库归档：清退前把将删行按 fetchedAt 年份写进同目录 archive-YYYY.db（同构 schema+FTS 触发器自动建索引）。
      导出失败跳过删除——宁涨不丢数据。返回是否已导出（true=可删）。 */
  private exportToArchive(where: string, args: unknown[]): boolean {
    const rows = this.db.prepare(`SELECT * FROM items WHERE ${where}`).all(...args as never[]) as Row[]
    if (!rows.length) return true
    const byYear = new Map<string, Row[]>()
    for (const r of rows) {
      const y = String(r.fetchedAt ?? '').slice(0, 4) || 'undated'
      byYear.set(y, [...(byYear.get(y) ?? []), r])
    }
    try {
      for (const [year, list] of byYear) {
        const file = join(dirname(this.path), `archive-${year}.db`)
        const adb = new DatabaseSync(file)
        try {
          adb.exec(SCHEMA)
          adb.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`) // 年库同样自描述纪元——按年库查询/迁移时可知它出自哪代结构
          if (this.ftsEnabled) { try { adb.exec(FTS) } catch { /* 无 FTS 也照常归档 */ } }
          const ins = adb.prepare(`INSERT OR IGNORE INTO items
            (id,hash,sourceId,topic,title,link,summary,content,publishedAt,fetchedAt,digestedDay,score,llmScore,llmReason,aiTitle,aiSummary,dupOf,dupCount,hotCycles,tags,reasons,state)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          adb.exec('BEGIN')
          try { for (const r of list) ins.run(...ITEM_COLS.map((c) => r[c]) as never[]) ; adb.exec('COMMIT') }
          catch (e) { adb.exec('ROLLBACK'); throw e }
        } finally { adb.close() }
        this.log.info(`archived ${list.length} items -> archive-${year}.db`)
      }
      return true
    } catch (e) {
      this.log.error(`archive export failed, keeping rows: ${e instanceof Error ? e.message : e}`)
      return false
    }
  }

  /** 清退：先过期后配额（低质优先 or 最老优先），SQL DELETE；删除前统一走年库归档 */
  private prune(): void {
    const days = this.retentionDays()
    if (days > 0) {
      const cutoff = new Date(Date.now() - days * 86400e3).toISOString()
      if (this.exportToArchive('fetchedAt < ?', [cutoff])) {
        const r = this.db.prepare('DELETE FROM items WHERE fetchedAt < ?').run(cutoff)
        if (Number(r.changes) > 0) this.log.info(`pruned ${r.changes} expired items (>${days}d)`)
      }
    }
    const over = this.count() - this.maxItems
    if (over <= 0) return
    let del: number
    if (this.pruneLowQuality()) {
      // 质量键=llmScore ?? 5：NULL 视为中档 5——未评分新条目不能被清退饿死
      // （否则它们还没轮到评分就先被删，撞上限后整库冻结）
      const cond = 'id IN (SELECT id FROM items ORDER BY COALESCE(llmScore, 5) ASC, fetchedAt ASC LIMIT ?)'
      del = this.exportToArchive(cond, [over])
        ? Number(this.db.prepare(`DELETE FROM items WHERE ${cond}`).run(over).changes)
        : 0
    } else {
      const cond = 'id IN (SELECT id FROM items ORDER BY fetchedAt ASC LIMIT ?)'
      del = this.exportToArchive(cond, [over])
        ? Number(this.db.prepare(`DELETE FROM items WHERE ${cond}`).run(over).changes)
        : 0
    }
    this.log.info(`pruned ${del} items (cap ${this.maxItems}${this.pruneLowQuality() ? ', low-quality first' : ''})`)
    if (del > 0) this.refreshWindow()
  }

  /** 跨窗口查询（/items 下推 + 专题候选）：filter+sort+FTS+分页全在 SQL */
  queryItems(opts: {
    day?: string; fetchedAfter?: string; fetchedBefore?: string; category?: string; source?: string; unread?: boolean; q?: string
    /** 专题：源白名单（精确 IN；空数组=不筛） */
    sources?: string[]
    /** 专题：发布/抓取回退时间区间（COALESCE(NULLIF(publishedAt,''),fetchedAt)） */
    publishedAfter?: string; publishedBefore?: string
    /** 专题：最低评分（COALESCE(llmScore, MIN(10,MAX(0,score*8)))，同 pickFinal 口径） */
    minScore?: number
    sort?: 'published' | 'fetched'; page?: number; pageSize?: number
    /** 冷启动首屏：窗口未就绪时跳过 COUNT 全表扫描（json_extract 逐行评估是大库瓶颈），先回页数据；total=-1+totalPending 标记让前端出列表后补查 */
    skipTotal?: boolean
  }): { total: number; totalPending?: boolean; items: FeedItem[] } {
    const where: string[] = ["json_extract(state,'$.hidden') IS NOT 1"]
    const args: unknown[] = []
    if (opts.day || opts.fetchedAfter) { where.push('fetchedAt >= ? AND fetchedAt <= ?'); args.push(opts.fetchedAfter || `${opts.day}T00:00:00`, opts.fetchedBefore || `${opts.day}T23:59:59.999Z`) }
    if (opts.category) { where.push('topic = ?'); args.push(opts.category) }
    if (opts.source) { where.push('sourceId LIKE ?'); args.push(`%${opts.source}%`) }
    if (opts.sources?.length) { where.push(`sourceId IN (${opts.sources.map(() => '?').join(',')})`); args.push(...opts.sources) }
    if (opts.publishedAfter || opts.publishedBefore) {
      where.push("COALESCE(NULLIF(publishedAt,''),fetchedAt) >= ? AND COALESCE(NULLIF(publishedAt,''),fetchedAt) <= ?")
      args.push(opts.publishedAfter || '0000-01-01', opts.publishedBefore || '9999-12-31')
    }
    if (typeof opts.minScore === 'number') { where.push('COALESCE(llmScore, MIN(10, MAX(0, score*8))) >= ?'); args.push(opts.minScore) }
    if (opts.unread) { where.push("json_extract(state,'$.read') IS NOT 1") }
    let from = 'FROM items'
    if (opts.q) {
      if (this.ftsEnabled && opts.q.length >= 3) { from = 'FROM items_fts JOIN items ON items.rowid = items_fts.rowid'; where.push('items_fts MATCH ?'); args.push(`"${opts.q.replace(/"/g, '""')}"`) }
      else { where.push("(title LIKE ? OR summary LIKE ?)"); args.push(`%${opts.q}%`, `%${opts.q}%`) } // 短词(<trigram 最小3字符)走 LIKE
    }
    const key = opts.sort === 'fetched' ? 'fetchedAt' : "COALESCE(NULLIF(publishedAt,''),fetchedAt)"
    const page = Math.max(1, opts.page ?? 1), size = opts.pageSize ?? 50
    const skipCount = opts.skipTotal === true && !this.windowReady
    const total = skipCount ? -1 : (this.db.prepare(`SELECT COUNT(*) c ${from} WHERE ${where.join(' AND ')}`).get(...args as (string | number | null)[]) as { c: number }).c
    const rows = this.db.prepare(`SELECT items.* ${from} WHERE ${where.join(' AND ')} ORDER BY ${key} DESC LIMIT ? OFFSET ?`).all(...args as (string | number | null)[], size, (page - 1) * size) as Row[]
    return { total, ...(skipCount ? { totalPending: true } : {}), items: rows.map(rowToItem) }
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

  /** .db 快照（VACUUM INTO）——全量灾备；先跑 integrity_check 预检：坏库不备份（备份坏库=留存坏档） */
  snapshot(file: string): void {
    const ic = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined
    if (ic && ic.integrity_check !== 'ok') throw new Error(`integrity_check failed: ${ic.integrity_check} — snapshot aborted`)
    mkdirSync(dirname(file), { recursive: true })
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  }

  close(): void { try { this.db.close() } catch { /* 幂等 */ } }
}
// === SECTION 3 END ===
