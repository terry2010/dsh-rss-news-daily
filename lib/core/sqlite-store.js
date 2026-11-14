/**
 * SQLite 持久层（DESIGN-SQLITE.md）——Store 同签名实现，引擎 node:sqlite。
 * items getter 有界（最近 maxItems 条），跨窗口查询走 queryItems。
 * 所有条目变更写穿透；meta/sources/health 内存镜像 + save 落盘。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, rmSync, createWriteStream, createReadStream, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
const noopLog = { info() { }, warn() { }, error() { } };
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
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
`;
/** 行数计数器触发器：在 warmWindow 里与种子值同事务创建——种子=绝对值重放，
    此后全部 INSERT/DELETE/state.hidden 翻转由触发器 O(1) 维护，COUNT 永不全扫。
    写放大：每行写多一次 counters UPDATE——比 JSON 序列化便宜得多。 */
const COUNTER_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS cnt_ai AFTER INSERT ON items BEGIN
  UPDATE counters SET n=n+1 WHERE key='total';
  UPDATE counters SET n=n+1 WHERE key='hidden' AND COALESCE(json_extract(NEW.state,'$.hidden'),0)=1;
END;
CREATE TRIGGER IF NOT EXISTS cnt_ad AFTER DELETE ON items BEGIN
  UPDATE counters SET n=n-1 WHERE key='total';
  UPDATE counters SET n=n-1 WHERE key='hidden' AND COALESCE(json_extract(OLD.state,'$.hidden'),0)=1;
END;
CREATE TRIGGER IF NOT EXISTS cnt_au AFTER UPDATE OF state ON items
  WHEN COALESCE(json_extract(OLD.state,'$.hidden'),0) IS NOT COALESCE(json_extract(NEW.state,'$.hidden'),0) BEGIN
  UPDATE counters SET n=n+(CASE WHEN COALESCE(json_extract(NEW.state,'$.hidden'),0)=1 THEN 1 ELSE -1 END) WHERE key='hidden';
END;
`;
const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, summary, content='items', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary); END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, summary) VALUES('delete', old.rowid, old.title, old.summary); END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, summary) VALUES('delete', old.rowid, old.title, old.summary);
  INSERT INTO items_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary); END;
`;
/** 状态 JSON 实列化：VIRTUAL 生成列=纯元数据操作（不重写表、任何库瞬时完成），
    让 unread/hidden 筛选从 json_extract 逐行评估变等值索引查找（=0 走索引，IS NOT 不走）。 */
const STATE_COL_HIDDEN = "ALTER TABLE items ADD COLUMN state_hidden INTEGER GENERATED ALWAYS AS (COALESCE(json_extract(state,'$.hidden'),0)) VIRTUAL";
const STATE_COL_READ = "ALTER TABLE items ADD COLUMN state_read INTEGER GENERATED ALWAYS AS (COALESCE(json_extract(state,'$.read'),0)) VIRTUAL";
/** 状态复合索引：(hidden, read, 默认排序表达式)——unread/可见筛选的 WHERE 与 ORDER BY 同索引直出，
    LIMIT 早退；2 列版只解决过滤、排序仍要 TEMP B-TREE 全量重排（大库下每请求 O(n log n) 死）。
    更名 v2：旧 idx_items_state 若存在由 DDL 段顺手 DROP（DROP INDEX 是纯元数据 O(1)）。 */
const IDX_ITEMS_STATE = 'CREATE INDEX IF NOT EXISTS idx_items_state2 ON items(state_hidden, state_read, COALESCE(NULLIF(publishedAt,\'\'),fetchedAt))';
const DROP_IDX_ITEMS_STATE_V1 = 'DROP INDEX IF EXISTS idx_items_state';
const IDX_ITEMS_PUBSORT = "CREATE INDEX IF NOT EXISTS idx_items_pubsort ON items(COALESCE(NULLIF(publishedAt,''),fetchedAt))";
const IDX_ITEMS_QUALITY = 'CREATE INDEX IF NOT EXISTS idx_items_quality ON items(COALESCE(llmScore,5), fetchedAt)';
const COUNTER_SEED_SQL = `INSERT OR REPLACE INTO counters (key,n) VALUES
  ('total',(SELECT COUNT(*) FROM items)),
  ('hidden',(SELECT COUNT(*) FROM items WHERE COALESCE(json_extract(state,'$.hidden'),0)=1))`;
function tableCols(db, table) {
    // table_xinfo 不用 table_info：VIRTUAL 生成列对后者不可见——会误判缺失反复 ALTER，stateColsReady 永远到不了 true
    return new Set(db.prepare(`PRAGMA table_xinfo(${table})`).all().map((r) => String(r.name)));
}
function indexExists(db, name) {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name);
}
function counterSeeded(db) {
    return !!db.prepare("SELECT n FROM counters WHERE key='total'").get();
}
/** 同步 schema 纪元：结构性变更（加列/改表/数据回填）时 +1，并在 openDb 迁移段挂对应步骤。
    记录于 PRAGMA user_version——SQLite 内建槽位，不占 meta kv；跳版本升级按序连跑幂等收敛。 */
const SCHEMA_VERSION = 1;
/** 完整性检查/打包备份的库大小阈值：全页扫/全量重写随库线性冻结事件循环——超此走降级路径 */
const SQLITE_CHECK_MAX_BYTES = 2 * 1024 ** 3; // 2GB
const yieldLoop = () => new Promise((r) => setImmediate(r));
const rowToItem = (r) => ({
    id: r.id, hash: r.hash, sourceId: r.sourceId, topic: r.topic ?? '',
    title: r.title, link: r.link ?? '', summary: r.summary ?? '',
    content: r.content ?? '', publishedAt: r.publishedAt ?? '',
    fetchedAt: r.fetchedAt, digestedDay: r.digestedDay ?? '',
    score: r.score ?? 0, llmScore: r.llmScore == null ? undefined : r.llmScore,
    llmReason: r.llmReason == null ? undefined : r.llmReason,
    aiTitle: r.aiTitle == null ? undefined : r.aiTitle,
    aiSummary: r.aiSummary == null ? undefined : r.aiSummary,
    dupOf: r.dupOf == null ? undefined : r.dupOf,
    dupCount: r.dupCount == null ? undefined : r.dupCount,
    hotCycles: r.hotCycles == null ? undefined : r.hotCycles,
    tags: r.tags ? JSON.parse(r.tags) : undefined,
    reasons: r.reasons ? JSON.parse(r.reasons) : [],
    state: r.state ? JSON.parse(r.state) : { read: false, hidden: false, liked: 0 },
});
const ITEM_COLS = ['id', 'hash', 'sourceId', 'topic', 'title', 'link', 'summary', 'content', 'publishedAt', 'fetchedAt', 'digestedDay', 'score', 'llmScore', 'llmReason', 'aiTitle', 'aiSummary', 'dupOf', 'dupCount', 'hotCycles', 'tags', 'reasons', 'state'];
/** lite 候选列：剔除 content/aiSummary 两个重文本（行体积 ~95% 在这两列）——大批量候选物化从几百 MB 降到几十 MB */
const LITE_COLS = ITEM_COLS.filter((c) => c !== 'content' && c !== 'aiSummary');
const itemToRow = (i) => [
    i.id, i.hash, i.sourceId, i.topic ?? '', i.title, i.link ?? '', i.summary ?? '', i.content ?? '',
    i.publishedAt ?? '', i.fetchedAt, i.digestedDay ?? '', i.score ?? 0, i.llmScore ?? null, i.llmReason ?? null,
    i.aiTitle ?? null, i.aiSummary ?? null, i.dupOf ?? null, i.dupCount ?? null, i.hotCycles ?? null,
    i.tags ? JSON.stringify(i.tags) : null, i.reasons ? JSON.stringify(i.reasons) : null,
    JSON.stringify(i.state ?? {}),
];
// === SECTION 1 END ===
/** node:sqlite + FTS5 探测（P1）：不可用/无 FTS5 返回 false → 调用方报错不降级 */
export function probeSqlite() {
    try {
        const d = new DatabaseSync(':memory:');
        let fts = false;
        try {
            d.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')`);
            d.exec('DROP TABLE t');
            fts = true;
        }
        catch { /* fts5 不可用 */ }
        d.close();
        return { ok: true, fts };
    }
    catch {
        return { ok: false, fts: false };
    }
}
export class SqliteStore {
    path;
    maxItemsFn;
    get maxItems() { return this.maxItemsFn(); }
    windowSize;
    log;
    retentionDays;
    pruneLowQuality;
    ftsEnabled;
    isIdleFn;
    db;
    metaObj = { lastFetchAt: '', lastDigestAt: '', lastDigestDay: '' };
    srcList = [];
    window = []; // items getter 的有界窗口（最近 winCap 条）——内存工作集，与库配额解耦
    windowReady = false; // 窗口是否已建——load() 后由 warmWindow 分块填充，就绪前 getter 走惰性同步兜底
    windowGen = 0; // 窗口代际：refreshWindow/addItems/clearItems 自增——warmWindow 半成品据此判脏
    countsReady = false; // counters 触发器+种子就绪——此前 count() 等回落真实 COUNT（随库线性增长，故尽快播种）
    countsDeferred = false; // 大库计数器种子排进空闲 DDL 队列——就绪前 count() 返回 -1（未知），queryItems 走 totalPending
    stateColsReady = false; // state_hidden/state_read 生成列就绪——此前 WHERE 用 json_extract 等价兜底
    ddlQueue = []; // 大库推迟 DDL（种子/索引单语句随库线性）——摊进空闲 tick 逐条跑
    ensuredArchives = new Set(); // 本进程已做同构 schema 的年库——archiveIds 批间不重复建
    archiveTodo = []; // 年库巡检队列：每日扫档入列、每个空闲 tick 收敛一个
    lastArchiveMaintAt = 0;
    dirtyItems = new Map(); // 自上次 save 以来被改过的条目（窗口 Proxy 脏标记）
    proxyCache = new WeakMap();
    /** 条目脏检测：窗口对象套 Proxy，任意层级写入（含 state.* 嵌套）都把根条目记入 dirtyItems——
        save() 只回写脏行。全窗口重写在万级条目库上是秒级事件循环阻塞（API 全卡）。 */
    track(value, mark) {
        if (value === null || typeof value !== 'object')
            return value;
        const hit = this.proxyCache.get(value);
        if (hit)
            return hit;
        const proxy = new Proxy(value, {
            get: (target, key) => this.track(Reflect.get(target, key), mark),
            set: (target, key, v) => {
                const changed = !Object.is(Reflect.get(target, key), v);
                const ok = Reflect.set(target, key, v);
                if (ok && changed)
                    mark();
                return ok;
            },
            deleteProperty: (target, key) => {
                const ok = Reflect.deleteProperty(target, key);
                if (ok)
                    mark();
                return ok;
            },
        });
        this.proxyCache.set(value, proxy);
        return proxy;
    }
    wrapItem(item) {
        return this.track(item, () => { this.dirtyItems.set(item.id, item); });
    }
    constructor(options) {
        this.path = options.path;
        const mi = options.maxItems;
        this.maxItemsFn = typeof mi === 'function' ? mi : () => mi ?? 1000;
        this.windowSize = options.windowItems ?? 30_000;
        this.retentionDays = options.retentionDays ?? (() => 0);
        this.pruneLowQuality = options.pruneLowQuality ?? (() => false);
        this.ftsEnabled = options.fts ?? true;
        this.isIdleFn = options.isIdle ?? (() => true);
        this.log = options.log ?? noopLog;
    }
    /** 窗口实际容量：min(窗口上限, 库配额)——配额比窗口小的库窗口仍是全量，行为与旧版一致 */
    winCap() { return Math.min(this.windowSize, this.maxItems); }
    async load() {
        mkdirSync(dirname(this.path), { recursive: true });
        // 老 JSON 归档（不迁移条目；sources 例外读入）
        const legacy = this.path.replace(/\.db$/, '.json');
        let legacySources = [];
        if (!existsSync(this.path) && existsSync(legacy)) {
            try {
                const raw = JSON.parse((await import('node:fs')).readFileSync(legacy, 'utf8'));
                legacySources = raw.sources ?? [];
            }
            catch { /* 解析失败也无妨——不迁移 */ }
            renameSync(legacy, `${legacy}.migrated`);
            this.log.info('legacy store.json archived to .migrated (items/meta not migrated)');
        }
        // 打开 + 轻量健全性探针：读系统目录首页——任何库都有此行，"文件不是库/页1损坏"立即抛；
        // SCHEMA 建表同包在探测里（坏库在建表阶段抛一样走隔离）。
        // 完整 integrity_check 不在启动路径跑：它同步全页扫描随库线性增长（314MB≈1.4s），
        // 同步执行会堵死事件循环——API 请求全部排队等它，表现为"进插件等几秒才出新闻"。
        // 完整校验推迟到 load() 后的空闲窗口（见 scheduleIntegrityCheck）。
        const openDb = () => {
            this.db = new DatabaseSync(this.path);
            this.db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
            this.db.exec('PRAGMA journal_mode=WAL');
            // schema 纪元判定必须在 SCHEMA 建表前：存量库（有 items 表、无版本号）= v1 基线；
            // v>SCHEMA_VERSION=库比插件新（降级运行）：不动结构只告警——加法索引/列对老代码无害
            const v = this.db.prepare('PRAGMA user_version').get().user_version;
            const hadItems = !!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='items'").get();
            if (v === 0 && hadItems)
                this.db.exec('PRAGMA user_version = 1');
            if (v > SCHEMA_VERSION)
                this.log.warn(`db schema v${v} > plugin v${SCHEMA_VERSION}（降级运行）——不动结构`);
            // 未来非加法迁移在此按序挂步：if (v < 2) { ALTER/BACKFILL…; PRAGMA user_version = 2 }
            this.db.exec(SCHEMA);
            this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        };
        try {
            openDb();
        }
        catch (e) {
            this.log.warn(`db open/sanity failed (${e instanceof Error ? e.message : e}); isolating and starting fresh`);
            this.isolateCorrupt();
            openDb(); // 新空库建表不会再坏——再坏是环境级问题，抛给 load() 外层处理
        }
        if (this.ftsEnabled) {
            try {
                this.db.exec(FTS);
            }
            catch (e) {
                this.log.warn(`fts schema failed: ${e instanceof Error ? e.message : e}`);
            }
        }
        // meta kv → 内存对象
        this.metaObj = { lastFetchAt: '', lastDigestAt: '', lastDigestDay: '' };
        for (const r of this.db.prepare('SELECT key, value FROM meta').all()) {
            try {
                Object.assign(this.metaObj, { [r.key]: JSON.parse(r.value) });
            }
            catch { /* 坏值跳过 */ }
        }
        // sources 表 → 内存（老 json 的 sources 合并进来）
        const srcRows = this.db.prepare('SELECT data FROM sources').all();
        this.srcList = srcRows.map((r) => JSON.parse(r.data));
        for (const ls of legacySources)
            if (!this.srcList.find((s) => s.url === ls.url))
                this.addSource(ls);
        // 窗口分块异步预热：万级条目库全量 SELECT+JSON.parse+Proxy 是秒级事件循环阻塞，
        // 同步跑会把 mountApi 之后的所有请求按在队列里（表现为"进插件等几秒才出新闻"）。
        // 分块让事件循环喘气、请求穿插处理；load() 先兑现，窗口未就绪的访问走 items getter 惰性兜底。
        // 重建路径（restoreFrom/坏库隔离重载）会二次进 load()：旧窗口是上一个库的数据——先作废再预热。
        this.window = [];
        this.windowReady = false;
        this.windowGen++; // 同时作废可能在飞的上一轮 warmWindow 半成品
        this.countsReady = false; // restoreFrom/隔离重建会再过 load——计数器等 warmWindow 重播种子自愈
        this.countsDeferred = false;
        this.stateColsReady = false;
        this.ddlQueue = [];
        // 启动不做清退（过期归档/超配额删除随 save() 生命周期走）——保库原样，大库冷启动不被二次阻塞
        void this.warmWindow()
            .catch((e) => this.log.warn(`window warm failed: ${e instanceof Error ? e.message : e}`));
        this.scheduleIntegrityCheck();
    }
    /** 坏库隔离：关句柄→改名存档→开全新空库（调用方随后重跑 load 建 schema+回填内存） */
    isolateCorrupt() {
        try {
            this.db?.close();
        }
        catch { /* 未打开 */ }
        if (existsSync(this.path))
            renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
        this.db = new DatabaseSync(this.path);
    }
    icTimer;
    lastIntegrityAt = 0;
    /** integrity_check 节奏：每 30min 探一次——距上次 >24h 且全系统空闲（任务队列空 + 无页面心跳）
        才真正执行（全页扫随库线性增长，忙时/用户在用时跑会卡 API）。
        命中损坏走与启动探针同一隔离路径+重跑 load。 */
    scheduleIntegrityCheck() {
        if (this.icTimer)
            clearInterval(this.icTimer); // restoreFrom/隔离重建都会再过 load()——只保留最新一个钟
        this.icTimer = setInterval(() => this.integrityTick(), 30 * 60_000);
        this.icTimer.unref?.();
    }
    integrityTick() {
        if (!this.isIdleFn())
            return; // 有任务在跑/排队/用户在用——下次再探
        // 1) 推迟 DDL 最高优先：每个空闲 tick 只跑一条（单语句随库线性，摊薄到多个空闲窗口）
        const job = this.ddlQueue.shift();
        if (job) {
            try {
                this.runDdlJob(job);
                this.log.info(`deferred ddl done: ${job} (剩 ${this.ddlQueue.length})`);
            }
            catch (e) {
                this.log.warn(`deferred ddl failed (${job}): ${e instanceof Error ? e.message : e}`);
            }
            return;
        }
        // 2) 年库巡检：每日扫档入列、每 tick 收敛一个文件（旧年库缺计数器/索引/状态列——ensureArchiveSchema 补全）
        this.archiveMaintainTick();
        const DAY = 24 * 3600_000;
        if (Date.now() - this.lastIntegrityAt < DAY)
            return;
        this.lastIntegrityAt = Date.now(); // 先记账——即便失败也不每分钟重扫大库
        // 大库门控：任何全页扫都随库线性冻结事件循环——超阈值直接跳过（备份快照路径仍做 quick_check 预检）
        if (this.dbFileSize() > SQLITE_CHECK_MAX_BYTES) {
            this.log.info('db >2GB：跳过定期完整性检查（全页扫会把宿主冻结分钟级）');
            return;
        }
        try {
            // quick_check 比 integrity_check 便宜约一个量级（跳索引一致性细查）——日检强度足够
            const ic = this.db.prepare('PRAGMA quick_check').get();
            if (ic && ic.quick_check !== 'ok') {
                this.log.error(`sqlite quick_check failed: ${ic.quick_check} — isolating corrupt db`);
                this.isolateCorrupt();
                void this.load().catch((e) => this.log.error(`reload after corrupt-isolate failed: ${e instanceof Error ? e.message : e}`));
            }
            else {
                this.log.info('sqlite quick_check: ok');
            }
        }
        catch (e) {
            this.log.warn(`deferred quick_check failed: ${e instanceof Error ? e.message : e}`);
        }
    }
    /** 年库巡检：每日把同目录 archive-*.db 入列，每个空闲 tick 收敛一个文件做同构 schema。
        旧年库的计数器种子是一次性 COUNT——摊到不同空闲窗口不叠加冻结。 */
    archiveMaintainTick() {
        const DAY = 24 * 3600_000;
        if (!this.archiveTodo.length) {
            if (Date.now() - this.lastArchiveMaintAt < DAY)
                return;
            this.lastArchiveMaintAt = Date.now();
            try {
                this.archiveTodo = readdirSync(dirname(this.path))
                    .filter((f) => /^archive-\d{4}\.db$/.test(f))
                    .map((f) => join(dirname(this.path), f));
            }
            catch {
                return;
            }
        }
        const f = this.archiveTodo.shift();
        if (!f)
            return;
        try {
            const adb = new DatabaseSync(f);
            try {
                this.ensureArchiveSchema(adb, f);
            }
            finally {
                adb.close();
            }
            this.log.info(`archive maintained: ${f}`);
        }
        catch (e) {
            this.log.warn(`archive maintain failed (${f}): ${e instanceof Error ? e.message : e}`);
        }
    }
    /** 热恢复：关库 → file 覆盖 store.db → 重新 load（meta/sources/窗口全部重建）。
        调用方须先停抓取/生成；脏窗口清空避免旧数据写回恢复库。
        用 renameSync 不用 copyFileSync：pending 与目标同目录同文件系统，rename 是 O(1) 原子换名——
        大库恢复从"同步拷贝 GB 级文件（分钟级冻结）"变瞬时。 */
    async restoreFrom(file) {
        try {
            this.db.close();
        }
        catch { /* 幂等 */ }
        for (const ext of ['', '-wal', '-shm'])
            rmSync(`${this.path}${ext}`, { force: true });
        renameSync(file, this.path);
        this.dirtyItems.clear();
        this.proxyCache = new WeakMap();
        await this.load();
    }
    refreshWindow() {
        // 不清 dirtyItems：窗口重建丢的是代理外壳，脏条目快照仍可回写（已删行 UPDATE 0 行无害，自清于下次 commit）
        this.window = this.db.prepare('SELECT * FROM items ORDER BY fetchedAt DESC LIMIT ?').all(this.winCap()).map((r) => this.wrapItem(rowToItem(r)));
        this.windowReady = true;
        this.windowGen++;
    }
    /** 分块预热：LIMIT/OFFSET 分批取行+逐行包裹，块间 setImmediate 让渡——事件循环不被一坨同步工作堵死。
        预热期间有写入（addItems/refreshWindow/clearItems）→ 代际变了，半成品弃之改同步重建（正确性优先）。 */
    /** 计数器种子+触发器：同 SAVEPOINT 原子执行——种子是绝对值重放，写入不可能穿插其间（单线程单写者）；
        触发器在种子后创建不会漏计。幂等可重跑（restoreFrom 后自动自愈）。
        用 SAVEPOINT 不用 BEGIN：importNdjson 的 for-await 事务可能与预热期交叠——
        SAVEPOINT 可嵌在外层事务内（独立时自成隐式事务），不会撞"within a transaction"
        也不会在失败时误回滚外层事务。若整个外层事务事后被回滚，种子消失→count() 缺失防御兜底。 */
    seedCounters() {
        this.db.exec('SAVEPOINT cnt_seed');
        this.db.exec(COUNTER_SEED_SQL);
        this.db.exec(COUNTER_TRIGGERS);
        this.db.exec('RELEASE cnt_seed');
        this.countsReady = true;
        this.countsDeferred = false;
    }
    /** state_hidden/state_read 生成列：VIRTUAL=纯元数据 ALTER（任何规模瞬时）——无需随大库推迟；
        复合索引让 unread/可见筛选走等值查找。 */
    ensureStateCols() {
        const cols = tableCols(this.db, 'items');
        if (!cols.has('state_hidden'))
            this.db.exec(STATE_COL_HIDDEN);
        if (!cols.has('state_read'))
            this.db.exec(STATE_COL_READ);
        this.stateColsReady = true;
    }
    /** 推迟 DDL 任务：大库上的单语句 O(库) 操作（计数器种子/索引新建）逐条摊进空闲 tick */
    runDdlJob(key) {
        switch (key) {
            case 'counter_seed':
                this.seedCounters();
                break;
            case 'idx_state':
                this.db.exec(`${DROP_IDX_ITEMS_STATE_V1}; ${IDX_ITEMS_STATE}`);
                break;
            case 'idx_pubsort':
                this.db.exec(IDX_ITEMS_PUBSORT);
                break;
            case 'idx_quality':
                this.db.exec(IDX_ITEMS_QUALITY);
                break;
        }
    }
    async warmWindow() {
        await new Promise((r) => setImmediate(r)); // 先让渡一拍：async 函数在首个 await 前是同步执行——没有这句建索引会跑回 load() 临界路径
        const gen0 = this.windowGen;
        const big = this.dbFileSize() > SQLITE_CHECK_MAX_BYTES;
        // —— 计数器：触发器幂等先挂上（已种子只补触发器）；未种子的小库立即播、大库排空闲队列
        try {
            this.db.exec(COUNTER_TRIGGERS);
            if (counterSeeded(this.db))
                this.countsReady = true;
            else if (big) {
                this.countsDeferred = true;
                this.ddlQueue.push('counter_seed');
                this.log.info('db >2GB：计数器种子推迟到空闲时段（两次全扫 COUNT 会冻结分钟级）');
            }
            else
                this.seedCounters();
        }
        catch (e) {
            try {
                this.db.exec('ROLLBACK TO cnt_seed');
                this.db.exec('RELEASE cnt_seed');
            }
            catch { /* 幂等 */ }
            this.log.warn(`counter seed failed: ${e instanceof Error ? e.message : e}`);
        }
        // —— 状态生成列：VIRTUAL ALTER 是元数据操作，任何规模即时
        try {
            this.ensureStateCols();
        }
        catch (e) {
            this.log.warn(`state cols failed: ${e instanceof Error ? e.message : e}`);
        }
        // —— 索引：已存在则瞬时；新建随库线性——大库排空闲队列（未建期间查询走无索引等价路径，只是慢不是错）
        const want = [
            { key: 'idx_state', sql: `${DROP_IDX_ITEMS_STATE_V1}; ${IDX_ITEMS_STATE}`, exists: indexExists(this.db, 'idx_items_state2') },
            { key: 'idx_pubsort', sql: IDX_ITEMS_PUBSORT, exists: indexExists(this.db, 'idx_items_pubsort') },
            { key: 'idx_quality', sql: IDX_ITEMS_QUALITY, exists: !this.pruneLowQuality() || indexExists(this.db, 'idx_items_quality') },
        ];
        for (const w of want) {
            if (w.exists)
                continue;
            if (big) {
                this.ddlQueue.push(w.key);
                continue;
            }
            try {
                this.db.exec(w.sql);
            }
            catch (e) {
                this.log.warn(`${w.key} failed: ${e instanceof Error ? e.message : e}`);
            }
        }
        const stmt = this.db.prepare('SELECT * FROM items ORDER BY fetchedAt DESC LIMIT ? OFFSET ?');
        const CHUNK = 1000;
        const out = [];
        const cap = this.winCap();
        for (let off = 0; off < cap; off += CHUNK) {
            if (this.windowReady)
                return; // 有调用方等不及走了惰性同步兜底——半成品丢
            const rows = stmt.all(CHUNK, off);
            for (const r of rows)
                out.push(this.wrapItem(rowToItem(r)));
            if (rows.length < CHUNK)
                break;
            await new Promise((r) => setImmediate(r));
        }
        if (this.windowReady)
            return;
        if (this.windowGen !== gen0) {
            this.refreshWindow();
            return;
        } // 预热期窗口被写过——半成品脏，同步重建保正确
        this.window = out;
        this.windowReady = true;
    }
    // ---- 公开契约（同 Store） ----
    get meta() { return this.metaObj; }
    get sources() { return this.srcList; }
    get items() {
        if (!this.windowReady)
            this.refreshWindow(); // 惰性兜底：预热未完成时第一个真需要的调用方付一次同步价
        return this.window;
    }
    get health() { return (this.metaObj.health ??= {}); }
    count() {
        // 计数器就绪后 COUNT(*) 不再全扫——百万/十亿行下 COUNT 是唯一会随库线性死亡的日常路径
        if (this.countsReady) {
            const r = this.db.prepare("SELECT n c FROM counters WHERE key='total'").get();
            if (r)
                return r.c;
            this.countsReady = false; // 种子被外层事务回滚（如导入失败）——退回真实 COUNT 直至下次 load 重播
        }
        if (this.countsDeferred)
            return -1; // 大库种子排空闲队列中——-1=未知，绝不付全扫代价
        return this.db.prepare('SELECT COUNT(*) c FROM items').get().c;
    }
    /** 可见总数（总数-屏蔽）——queryItems 无筛选时用它替代 json_extract 全扫 COUNT */
    visibleCount() {
        if (this.countsReady) {
            const t = this.db.prepare("SELECT n c FROM counters WHERE key='total'").get();
            const h = this.db.prepare("SELECT n c FROM counters WHERE key='hidden'").get();
            if (t && h)
                return t.c - h.c;
            this.countsReady = false;
        }
        if (this.countsDeferred)
            return -1;
        return this.db.prepare("SELECT COUNT(*) c FROM items WHERE COALESCE(json_extract(state,'$.hidden'),0) IS NOT 1").get().c;
    }
    /** 按 id 取条目：窗口先查（代理对象，改 state 标脏），未命中走主键点查——
        高摄入下被挤出窗口但仍在库的条目照常可已读/屏蔽/喜欢。 */
    getItem(id) {
        const w = this.window.find((i) => i.id === id);
        if (w)
            return w;
        const r = this.db.prepare('SELECT * FROM items WHERE id=?').get(id);
        return r ? this.wrapItem(rowToItem(r)) : undefined;
    }
    /** 非窗口条目标脏：queryItems 取出的普通对象经管线写入 llmScore 等字段后，
        借 dirtyItems→save() 的既有 UPDATE 通道回写（窗口代理是另一条通道）。
        lite 行（content/aiSummary 缺值）先自动补水——否则 save() 会把缺省 '' 当真值覆盖正文字段。 */
    persistItems(items) {
        const lite = items.filter((i) => i.__lite);
        if (lite.length)
            this.hydrateItems(lite);
        for (const i of items)
            this.dirtyItems.set(i.id, i);
    }
    /** lite 候选补水：批量点查 content/aiSummary 填回传入对象（IN 分块，单次点查微秒级）。
        只写存在列的行——查不到的 id 保留原值（含 lite 缺省 ''）。persistItems 前置调用。 */
    hydrateItems(items) {
        if (!this.db || !items.length)
            return;
        const CH = 500;
        for (let off = 0; off < items.length; off += CH) {
            const slice = items.slice(off, off + CH);
            const rows = this.db.prepare(`SELECT id, content, aiSummary FROM items WHERE id IN (${slice.map(() => '?').join(',')})`)
                .all(...slice.map((i) => i.id));
            const byId = new Map(rows.map((r) => [r.id, r]));
            for (const it of slice) {
                const r = byId.get(it.id);
                if (r) {
                    it.content = r.content ?? '';
                    it.aiSummary = r.aiSummary ?? undefined;
                    delete it.__lite; // 补水完成摘标记
                }
            }
        }
    }
    setHealth(id, health) { this.health[id] = health; }
    getHealth(id) { return this.health[id]; }
    addSource(source) {
        this.db.prepare('INSERT OR REPLACE INTO sources (id,url,data) VALUES (?,?,?)')
            .run(source.id, source.url, JSON.stringify(source));
        const i = this.srcList.findIndex((s) => s.id === source.id);
        if (i >= 0)
            this.srcList[i] = source;
        else
            this.srcList.push(source);
    }
    /** 按源分块删除：sourceId 索引批取 id→DELETE→让渡——单语句 DELETE 在百万级匹配时
        是分钟级冻结+巨型 WAL（计数器/FTS 触发器逐行触发）。源删除=用户明确不要了，不归档。 */
    async removeItemsBySource(sourceId) {
        let removed = 0;
        for (;;) {
            const ids = this.db.prepare('SELECT id FROM items WHERE sourceId=? LIMIT 2000').all(sourceId).map((r) => r.id);
            if (!ids.length)
                break;
            removed += Number(this.db.prepare(`DELETE FROM items WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids).changes);
            if (ids.length < 2000)
                break;
            await yieldLoop();
        }
        if (removed > 0) {
            this.dropWindowIds(new Set((this.window.filter((i) => i.sourceId === sourceId)).map((i) => i.id)));
        }
        return removed;
    }
    async removeSource(id) {
        const i = this.srcList.findIndex((s) => s.id === id);
        if (i < 0)
            return false;
        this.db.prepare('DELETE FROM sources WHERE id=?').run(id);
        const removedItems = await this.removeItemsBySource(id);
        void removedItems;
        this.srcList.splice(i, 1);
        return true;
    }
    addItems(items) {
        const ins = this.db.prepare(`INSERT OR IGNORE INTO items
      (id,hash,sourceId,topic,title,link,summary,content,publishedAt,fetchedAt,digestedDay,score,llmScore,llmReason,aiTitle,aiSummary,dupOf,dupCount,hotCycles,tags,reasons,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const fresh = [];
        this.db.exec('BEGIN');
        try {
            for (const i of items) {
                if ((ins.run(...itemToRow(i))).changes > 0)
                    fresh.push(i);
            }
            this.db.exec('COMMIT');
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
        // 逐条 unshift 是 O(n·k)；反转后一次前插等价（每条 unshift 会把已插入项逆序压到队首）
        this.window.splice(0, 0, ...fresh.reverse().map((i) => this.wrapItem(i)));
        if (this.window.length > this.winCap())
            this.window.length = this.winCap();
        this.windowGen++; // 窗口被写——warmWindow 半成品据此判脏重建
        return fresh.length;
    }
    markDigested(ids, day) {
        const u = this.db.prepare('UPDATE items SET digestedDay=? WHERE id=?');
        this.db.exec('BEGIN');
        try {
            for (const id of ids)
                u.run(day, id);
            this.db.exec('COMMIT');
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
        const idSet = new Set(ids); // O(窗口×ids)→O(窗口)——includes 线性查找在大窗口下是隐形税
        for (const i of this.window)
            if (idSet.has(i.id))
                i.digestedDay = day;
    }
    countUndigested(day) {
        // `digestedDay != ?` 永远不吃索引（全表扫）；等价改写：总数(计数器 O(1)) − 当日已消化(索引计数)
        const digested = this.db.prepare('SELECT COUNT(*) c FROM items WHERE digestedDay = ?').get(day).c;
        const total = this.count();
        return total < 0 ? -1 : total - digested; // 大库种子未就位时 -1=未知
    }
    /** save：脏条目回写 + meta/health 落 kv（写穿透已在各处做，save 兜底）。
        只 UPDATE 自上次 save 以来被改过的行——万级窗口全量重写会把事件循环堵秒级。 */
    async save() {
        const dirtyItems = [...this.dirtyItems.values()];
        this.db.exec('BEGIN');
        try {
            if (dirtyItems.length) {
                const up = this.db.prepare(`UPDATE items SET topic=?,title=?,link=?,summary=?,content=?,publishedAt=?,digestedDay=?,score=?,llmScore=?,llmReason=?,aiTitle=?,aiSummary=?,dupOf=?,dupCount=?,hotCycles=?,tags=?,reasons=?,state=? WHERE id=?`);
                for (const i of dirtyItems) {
                    const r = itemToRow(i);
                    up.run(r[3], r[4], r[5], r[6], r[7], r[8], r[10], r[11], r[12], r[13], r[14], r[15], r[16], r[17], r[18], r[19], r[20], r[21], i.id);
                }
            }
            const setMeta = this.db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)');
            for (const [k, v] of Object.entries(this.metaObj))
                if (k !== 'health')
                    setMeta.run(k, JSON.stringify(v));
            setMeta.run('health', JSON.stringify(this.metaObj.health ?? {}));
            this.db.exec('COMMIT');
            this.dirtyItems.clear();
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
        await this.prune();
    }
    /** 清空全部条目（含 FTS+内存窗口）；返回删除数。
        大库走 DROP+重建：DELETE 会逐行触发计数器/FTS 触发器且 WAL 涨到库体量——
        DROP TABLE 是摘 B-tree 根的元数据级操作，空库重建 schema 全部瞬时。 */
    async clearItems() {
        const n = this.count(); // 大库种子未就位时为 -1，如实返回
        if (n >= 0 && n < 100_000) {
            this.db.exec('DELETE FROM items'); // 小库单语句即完，不走重建
        }
        else {
            this.db.exec('BEGIN');
            try {
                this.db.exec('DROP TABLE IF EXISTS items_fts'); // 触发器随 items 销毁；fts 表随重建
                this.db.exec('DROP TABLE items');
                this.db.exec(SCHEMA);
                if (this.ftsEnabled)
                    this.db.exec(FTS);
                this.db.exec(COUNTER_TRIGGERS);
                this.db.exec("INSERT OR REPLACE INTO counters (key,n) VALUES ('total',0),('hidden',0)");
                this.db.exec('COMMIT');
            }
            catch (e) {
                this.db.exec('ROLLBACK');
                throw e;
            }
            this.ensureStateCols(); // VIRTUAL 列瞬时；索引在空库上瞬时
            for (const sql of [IDX_ITEMS_STATE, IDX_ITEMS_PUBSORT]) {
                try {
                    this.db.exec(sql);
                }
                catch { /* 幂等兜底 */ }
            }
            if (this.pruneLowQuality()) {
                try {
                    this.db.exec(IDX_ITEMS_QUALITY);
                }
                catch { /* 同上 */ }
            }
            this.countsReady = true;
            this.countsDeferred = false;
            this.ddlQueue = this.ddlQueue.filter((k) => k !== 'counter_seed'); // 空库种子已就位，队列里的作废
        }
        this.window = [];
        this.windowReady = true;
        this.windowGen++;
        this.dirtyItems.clear();
        return n;
    }
    /** 年库同构 schema：SCHEMA+纪元+FTS+计数器种子/触发器+状态列+排序索引——
        与热库 warmWindow 同一套硬化件，否则年库永远是"落后一代"的裸库（apiArchive 全扫）。
        每文件每进程只做一次；种子是首次写入时的一次性 COUNT（旧大年库付一次全扫）。 */
    ensureArchiveSchema(adb, file) {
        if (this.ensuredArchives.has(file))
            return;
        adb.exec(SCHEMA);
        adb.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        if (this.ftsEnabled) {
            try {
                adb.exec(FTS);
            }
            catch { /* 无 FTS 也照常归档 */ }
        }
        try {
            adb.exec(COUNTER_TRIGGERS);
            if (!counterSeeded(adb)) {
                adb.exec('SAVEPOINT aseed');
                adb.exec(COUNTER_SEED_SQL);
                adb.exec('RELEASE aseed');
            }
        }
        catch (e) {
            try {
                adb.exec('ROLLBACK TO aseed');
                adb.exec('RELEASE aseed');
            }
            catch { /* 幂等 */ }
            this.log.warn(`archive counter seed failed (${file}): ${e instanceof Error ? e.message : e}`);
        }
        try {
            const cols = tableCols(adb, 'items');
            if (!cols.has('state_hidden'))
                adb.exec(STATE_COL_HIDDEN);
            if (!cols.has('state_read'))
                adb.exec(STATE_COL_READ);
            adb.exec(DROP_IDX_ITEMS_STATE_V1);
            adb.exec(IDX_ITEMS_STATE);
            adb.exec(IDX_ITEMS_PUBSORT);
        }
        catch (e) {
            this.log.warn(`archive ddl failed (${file}): ${e instanceof Error ? e.message : e}`);
        }
        this.ensuredArchives.add(file);
    }
    /** 年库归档：把给定 id 集的行按 fetchedAt 年份写进同目录 archive-YYYY.db（同构 schema+FTS 触发器自动建索引）。
        导出失败跳过删除——宁涨不丢数据。返回是否已导出（true=可删）。 */
    archiveIds(ids) {
        const rows = this.db.prepare(`SELECT * FROM items WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
        if (!rows.length)
            return true;
        const byYear = new Map();
        for (const r of rows) {
            const y = String(r.fetchedAt ?? '').slice(0, 4) || 'undated';
            byYear.set(y, [...(byYear.get(y) ?? []), r]);
        }
        try {
            for (const [year, list] of byYear) {
                const file = join(dirname(this.path), `archive-${year}.db`);
                const adb = new DatabaseSync(file);
                try {
                    this.ensureArchiveSchema(adb, file);
                    const ins = adb.prepare(`INSERT OR IGNORE INTO items
            (id,hash,sourceId,topic,title,link,summary,content,publishedAt,fetchedAt,digestedDay,score,llmScore,llmReason,aiTitle,aiSummary,dupOf,dupCount,hotCycles,tags,reasons,state)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
                    adb.exec('BEGIN');
                    try {
                        for (const r of list)
                            ins.run(...ITEM_COLS.map((c) => r[c]));
                        adb.exec('COMMIT');
                    }
                    catch (e) {
                        adb.exec('ROLLBACK');
                        throw e;
                    }
                }
                finally {
                    adb.close();
                }
                this.log.info(`archived ${list.length} items -> archive-${year}.db`);
            }
            return true;
        }
        catch (e) {
            this.log.error(`archive export failed, keeping rows: ${e instanceof Error ? e.message : e}`);
            return false;
        }
    }
    /** 窗口原位剔除已删 id——不整窗 SELECT* 重建（30k 行重载≈1s 同步，高摄入下每周期都付） */
    dropWindowIds(ids) {
        if (!ids.size)
            return;
        const before = this.window.length;
        this.window = this.window.filter((i) => !ids.has(i.id));
        if (this.window.length !== before)
            this.windowGen++;
    }
    /** 分块清退：索引批取 id（LIMIT 有界）→ 归档 → 删除 → 让渡。
        单语句全量 DELETE 随行数线性冻结事件循环——大库下必须摊成无感后台批。
        selectIds 必须是索引驱动的取 id 语句（不含 LIMIT——由循环按批追加）。 */
    async pruneByIds(selectIds, args, max, label) {
        const CHUNK = 2000;
        let done = 0;
        const deleted = new Set();
        for (;;) {
            const want = Math.min(CHUNK, max - done);
            if (want <= 0)
                break;
            const ids = this.db.prepare(`${selectIds} LIMIT ?`).all(...args, want).map((r) => r.id);
            if (!ids.length)
                break;
            if (!this.archiveIds(ids))
                break; // 归档失败跳过删除——宁涨不丢
            const del = Number(this.db.prepare(`DELETE FROM items WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids).changes);
            for (const id of ids)
                deleted.add(id);
            done += del;
            if (ids.length < want)
                break;
            await yieldLoop(); // 批间让渡——清退摊成后台工作，不把请求按在队列里
        }
        if (done > 0) {
            this.log.info(`pruned ${done} items (${label})`);
            this.dropWindowIds(deleted);
        }
    }
    /** 清退：先过期后配额（低质优先 or 最老优先）——分块归档+删除，块间让渡 */
    async prune() {
        const days = this.retentionDays();
        if (days > 0) {
            const cutoff = new Date(Date.now() - days * 86400e3).toISOString();
            await this.pruneByIds('SELECT id FROM items WHERE fetchedAt < ? ORDER BY fetchedAt', [cutoff], Number.MAX_SAFE_INTEGER, `expired >${days}d`);
        }
        const over = this.count() - this.maxItems;
        if (over <= 0)
            return;
        if (this.pruneLowQuality()) {
            // 质量键=llmScore ?? 5：NULL 视为中档 5——未评分新条目不能被清退饿死
            // （否则它们还没轮到评分就先被删，撞上限后整库冻结）。idx_items_quality 让排序走索引不整表排序。
            await this.pruneByIds('SELECT id FROM items ORDER BY COALESCE(llmScore, 5) ASC, fetchedAt ASC', [], over, `cap ${this.maxItems}, low-quality first`);
        }
        else {
            await this.pruneByIds('SELECT id FROM items ORDER BY fetchedAt ASC', [], over, `cap ${this.maxItems}`);
        }
    }
    /** WHERE/FROM/排序键构建：queryItems 分页与 queryItemsChunked 直取共用同一套谓词 */
    itemQuery(opts) {
        // 生成列就绪后用等值查找（走 idx_items_state2）；否则 json_extract 等价兜底——两路同语义
        const where = [this.stateColsReady ? 'state_hidden = 0' : "json_extract(state,'$.hidden') IS NOT 1"];
        const args = [];
        if (opts.day || opts.fetchedAfter) {
            where.push('fetchedAt >= ? AND fetchedAt <= ?');
            args.push(opts.fetchedAfter || `${opts.day}T00:00:00`, opts.fetchedBefore || `${opts.day}T23:59:59.999Z`);
        }
        if (opts.category) {
            where.push('topic = ?');
            args.push(opts.category);
        }
        if (opts.source) {
            // 已知源 id → 等值走 idx_items_source；否则保留子串模糊（%x% 全扫——调用方尽量传全 id）
            if (this.srcList.some((s) => s.id === opts.source)) {
                where.push('sourceId = ?');
                args.push(opts.source);
            }
            else {
                where.push('sourceId LIKE ?');
                args.push(`%${opts.source}%`);
            }
        }
        if (opts.sources?.length) {
            where.push(`sourceId IN (${opts.sources.map(() => '?').join(',')})`);
            args.push(...opts.sources);
        }
        if (opts.publishedAfter || opts.publishedBefore) {
            where.push("COALESCE(NULLIF(publishedAt,''),fetchedAt) >= ? AND COALESCE(NULLIF(publishedAt,''),fetchedAt) <= ?");
            args.push(opts.publishedAfter || '0000-01-01', opts.publishedBefore || '9999-12-31');
        }
        if (typeof opts.minScore === 'number') {
            where.push('COALESCE(llmScore, MIN(10, MAX(0, score*8))) >= ?');
            args.push(opts.minScore);
        }
        if (opts.excludeDigestedDay) {
            where.push('(digestedDay IS NULL OR digestedDay != ?)');
            args.push(opts.excludeDigestedDay);
        }
        if (opts.topics?.length) {
            where.push(`COALESCE(NULLIF(topic,''),'综合') IN (${opts.topics.map(() => '?').join(',')})`);
            args.push(...opts.topics);
        }
        if (opts.unread) {
            where.push(this.stateColsReady ? 'state_read = 0' : "json_extract(state,'$.read') IS NOT 1");
        }
        let from = 'FROM items';
        if (opts.q) {
            if (this.ftsEnabled && opts.q.length >= 3) {
                from = 'FROM items_fts JOIN items ON items.rowid = items_fts.rowid';
                where.push('items_fts MATCH ?');
                args.push(`"${opts.q.replace(/"/g, '""')}"`);
            }
            else {
                where.push("(title LIKE ? OR summary LIKE ?)");
                args.push(`%${opts.q}%`, `%${opts.q}%`);
            } // 短词(<trigram 最小3字符)走 LIKE
        }
        const key = opts.sort === 'fetched' ? 'fetchedAt' : "COALESCE(NULLIF(publishedAt,''),fetchedAt)";
        return { from, where, args, key };
    }
    /** 跨窗口查询（/items 下推 + 专题候选）：filter+sort+FTS+分页全在 SQL */
    queryItems(opts) {
        const { from, where, args, key } = this.itemQuery(opts);
        const w = where.join(' AND ');
        // 直取模式（候选池）：不分页不计数——大库下候选集本身有界于 limit，COUNT 是浪费。
        // lite=true 剔除 content/aiSummary 两个重文本列（行体积 ~95% 在这两列）——消费方挑出小集合后 hydrateItems() 补水。
        // 注意：lite 行的 content=''/aiSummary=undefined 是缺值非真值——persistItems 内有 __lite 标记自动兜底补水。
        if (opts.limit) {
            const cols = opts.lite ? LITE_COLS.map((c) => `items.${c}`).join(',') : 'items.*';
            const rows = this.db.prepare(`SELECT ${cols} ${from} WHERE ${w} ORDER BY ${key} DESC LIMIT ?`).all(...args, opts.limit);
            return {
                total: -1, totalPending: true,
                items: rows.map((r) => { const it = rowToItem(r); if (opts.lite)
                    it.__lite = true; return it; }),
            };
        }
        const page = Math.max(1, opts.page ?? 1), size = opts.pageSize ?? 50;
        const skipCount = (opts.skipTotal === true && !this.countsReady) || this.countsDeferred; // 计数器种子完成后 COUNT 已 O(1)；大库种子排队中继续 pending
        // 无筛选（默认视图=列表 99% 请求）走计数器 O(1)——json_extract 全扫 COUNT 随库线性死亡；
        // 有筛选走真实 COUNT（索引区间有界：topic/source/date/状态列都是索引列）
        const unfiltered = !opts.day && !opts.fetchedAfter && !opts.fetchedBefore && !opts.category && !opts.source
            && !opts.sources?.length && !opts.publishedAfter && !opts.publishedBefore
            && opts.minScore === undefined && !opts.excludeDigestedDay && !opts.topics?.length && !opts.unread && !opts.q;
        const total = skipCount ? -1
            : unfiltered ? this.visibleCount()
                : this.db.prepare(`SELECT COUNT(*) c ${from} WHERE ${w}`).get(...args).c;
        const rows = this.db.prepare(`SELECT items.* ${from} WHERE ${w} ORDER BY ${key} DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
        return { total, ...(total === -1 || skipCount ? { totalPending: true } : {}), items: rows.map(rowToItem) };
    }
    /** 大候选集分块直取（异步）：单条 SELECT 物化万级行仍是数百 ms 同步段（启动补跑日报正撞首屏）——
        切成 4k 片+片间让渡，API 请求插缝服务。列/lite 语义与 limit 模式一致。 */
    async queryItemsChunked(opts) {
        const { from, where, args, key } = this.itemQuery(opts);
        const cols = opts.lite ? LITE_COLS.map((c) => `items.${c}`).join(',') : 'items.*';
        const CH = 4000;
        const stmt = this.db.prepare(`SELECT ${cols} ${from} WHERE ${where.join(' AND ')} ORDER BY ${key} DESC LIMIT ? OFFSET ?`);
        const out = [];
        for (let off = 0; off < opts.limit; off += CH) {
            const want = Math.min(CH, opts.limit - off);
            const rows = stmt.all(...args, want, off);
            for (const r of rows) {
                const it = rowToItem(r);
                if (opts.lite)
                    it.__lite = true;
                out.push(it);
            }
            if (rows.length < want)
                break;
            await yieldLoop();
        }
        return out;
    }
    // ---- P7 导出/导入 ----
    /** NDJSON 流式导出：meta头 + items + sources + digests */
    async exportNdjson(file, digestsDir, scope = 'all') {
        mkdirSync(dirname(file), { recursive: true });
        const w = createWriteStream(file);
        const write = (o) => new Promise((res) => w.write(JSON.stringify(o) + '\n', () => res()));
        await write({ type: 'meta', schemaVersion: 1, exportedAt: new Date().toISOString() });
        let n = 0;
        if (scope !== 'digests') {
            for (const r of this.db.prepare('SELECT * FROM items').iterate()) {
                await write({ type: 'item', data: rowToItem(r) });
                n++;
            }
            for (const s of this.srcList)
                await write({ type: 'source', data: s });
        }
        if (scope !== 'items') {
            const { readdirSync, readFileSync } = await import('node:fs');
            for (const f of readdirSync(digestsDir).filter((f) => f.endsWith('.md'))) {
                const day = f.split('-').slice(0, 3).join('-');
                const kind = f.includes('hourly') ? 'hourly' : 'daily';
                await write({ type: 'digest', day, kind, data: readFileSync(join(digestsDir, f), 'utf8') });
            }
        }
        await new Promise((res) => w.end(() => res()));
        return n;
    }
    /** NDJSON 导入：逐行 parse+merge 幂等 */
    async importNdjson(file, digestsDir) {
        const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
        const ins = this.db.prepare(`INSERT OR IGNORE INTO items
      (id,hash,sourceId,topic,title,link,summary,content,publishedAt,fetchedAt,digestedDay,score,llmScore,llmReason,aiTitle,aiSummary,dupOf,dupCount,hotCycles,tags,reasons,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const counts = { items: 0, sources: 0, digests: 0 };
        const { writeFileSync, existsSync: ex } = await import('node:fs');
        this.db.exec('BEGIN');
        let inTxn = 0; // 分批提交：巨型导入单事务会让 WAL 涨到导入体量；批次断点幂等可重导
        try {
            for await (const line of rl) {
                if (!line.trim())
                    continue;
                const o = JSON.parse(line);
                if (o.type === 'item') {
                    if (ins.run(...itemToRow(o.data)).changes > 0)
                        counts.items++;
                    if (++inTxn >= 10_000) {
                        this.db.exec('COMMIT');
                        this.db.exec('BEGIN');
                        inTxn = 0;
                    }
                }
                else if (o.type === 'source') {
                    const src = o.data;
                    if (!this.srcList.find((x) => x.url === src.url)) {
                        this.addSource(src);
                        counts.sources++;
                    }
                }
                else if (o.type === 'digest' && o.day) {
                    mkdirSync(digestsDir, { recursive: true });
                    const f = join(digestsDir, `${o.day}${o.kind === 'hourly' ? '-hourly' : '-rss-briefing'}.md`);
                    if (!ex(f)) {
                        writeFileSync(f, o.data);
                        counts.digests++;
                    }
                }
            }
            this.db.exec('COMMIT');
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
        this.refreshWindow();
        return counts;
    }
    /** 库文件字节数——备份/完整性检查的大小门控依据 */
    dbFileSize() { try {
        return statSync(this.path).size;
    }
    catch {
        return 0;
    } }
    get dbPath() { return this.path; }
    /** WAL 合并入主文件并截断——此后 .db 文件自身就是一致快照点（直接拷贝即有效备份，免 VACUUM 全量重写） */
    checkpointWal() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
    /** .db 快照（VACUUM INTO）——全量灾备；先跑 quick_check 预检：坏库不备份（备份坏库=留存坏档）。
        仅小库走此路径（VACUUM INTO 全量重写随库线性——大库备份走 checkpointWal+文件拷贝）。 */
    snapshot(file) {
        const ic = this.db.prepare('PRAGMA quick_check').get();
        if (ic && ic.quick_check !== 'ok')
            throw new Error(`quick_check failed: ${ic.quick_check} — snapshot aborted`);
        mkdirSync(dirname(file), { recursive: true });
        this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    }
    close() { try {
        this.db.close();
    }
    catch { /* 幂等 */ } }
}
// === SECTION 3 END ===
//# sourceMappingURL=sqlite-store.js.map