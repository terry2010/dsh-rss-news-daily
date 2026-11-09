/**
 * SQLite 持久层（DESIGN-SQLITE.md）——Store 同签名实现，引擎 node:sqlite。
 * items getter 有界（最近 maxItems 条），跨窗口查询走 queryItems。
 * 所有条目变更写穿透；meta/sources/health 内存镜像 + save 落盘。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, copyFileSync, rmSync, createWriteStream, createReadStream } from 'node:fs';
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
    log;
    retentionDays;
    pruneLowQuality;
    ftsEnabled;
    db;
    metaObj = { lastFetchAt: '', lastDigestAt: '', lastDigestDay: '' };
    srcList = [];
    window = []; // items getter 的有界窗口（最近 maxItems 条）
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
        this.retentionDays = options.retentionDays ?? (() => 0);
        this.pruneLowQuality = options.pruneLowQuality ?? (() => false);
        this.ftsEnabled = options.fts ?? true;
        this.log = options.log ?? noopLog;
    }
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
        // 打开 + 完整性检查（P6：损坏→改名隔离+全新空库）
        try {
            this.db = new DatabaseSync(this.path);
            const ic = this.db.prepare('PRAGMA integrity_check').get();
            if (ic && ic.integrity_check !== 'ok')
                throw new Error(`integrity: ${ic.integrity_check}`);
        }
        catch (e) {
            this.log.warn(`db open/integrity failed (${e instanceof Error ? e.message : e}); isolating and starting fresh`);
            try {
                this.db?.close();
            }
            catch { /* 未打开 */ }
            if (existsSync(this.path))
                renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
            this.db = new DatabaseSync(this.path);
        }
        this.db.exec('PRAGMA journal_mode=WAL');
        this.db.exec(SCHEMA);
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
        this.refreshWindow();
        this.prune();
    }
    /** 热恢复：关库 → file 覆盖 store.db → 重新 load（meta/sources/窗口全部重建）。
        调用方须先停抓取/生成；脏窗口清空避免旧数据写回恢复库。 */
    async restoreFrom(file) {
        try {
            this.db.close();
        }
        catch { /* 幂等 */ }
        for (const ext of ['', '-wal', '-shm'])
            rmSync(`${this.path}${ext}`, { force: true });
        copyFileSync(file, this.path);
        this.dirtyItems.clear();
        this.proxyCache = new WeakMap();
        await this.load();
    }
    refreshWindow() {
        // 不清 dirtyItems：窗口重建丢的是代理外壳，脏条目快照仍可回写（已删行 UPDATE 0 行无害，自清于下次 commit）
        this.window = this.db.prepare('SELECT * FROM items ORDER BY fetchedAt DESC LIMIT ?').all(this.maxItems).map((r) => this.wrapItem(rowToItem(r)));
    }
    // ---- 公开契约（同 Store） ----
    get meta() { return this.metaObj; }
    get sources() { return this.srcList; }
    get items() { return this.window; }
    get health() { return (this.metaObj.health ??= {}); }
    count() { return this.db.prepare('SELECT COUNT(*) c FROM items').get().c; }
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
    removeItemsBySource(sourceId) {
        const removed = Number(this.db.prepare('DELETE FROM items WHERE sourceId=?').run(sourceId).changes);
        if (removed > 0)
            this.refreshWindow();
        return removed;
    }
    removeSource(id) {
        const i = this.srcList.findIndex((s) => s.id === id);
        if (i < 0)
            return false;
        this.db.exec('BEGIN');
        let removedItems = 0;
        try {
            this.db.prepare('DELETE FROM sources WHERE id=?').run(id);
            removedItems = Number(this.db.prepare('DELETE FROM items WHERE sourceId=?').run(id).changes);
            this.db.exec('COMMIT');
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
        if (removedItems > 0)
            this.refreshWindow();
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
        if (this.window.length > this.maxItems)
            this.window.length = this.maxItems;
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
        for (const i of this.window)
            if (ids.includes(i.id))
                i.digestedDay = day;
    }
    countUndigested(day) {
        return this.db.prepare("SELECT COUNT(*) c FROM items WHERE digestedDay != ?").get(day).c;
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
        this.prune();
    }
    /** 清空全部条目（含 FTS 联动+内存窗口）；返回删除数 */
    clearItems() {
        const n = this.count();
        this.db.exec('DELETE FROM items');
        this.window = [];
        this.dirtyItems.clear();
        return n;
    }
    /** 年库归档：清退前把将删行按 fetchedAt 年份写进同目录 archive-YYYY.db（同构 schema+FTS 触发器自动建索引）。
        导出失败跳过删除——宁涨不丢数据。返回是否已导出（true=可删）。 */
    exportToArchive(where, args) {
        const rows = this.db.prepare(`SELECT * FROM items WHERE ${where}`).all(...args);
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
                    adb.exec(SCHEMA);
                    if (this.ftsEnabled) {
                        try {
                            adb.exec(FTS);
                        }
                        catch { /* 无 FTS 也照常归档 */ }
                    }
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
    /** 清退：先过期后配额（低质优先 or 最老优先），SQL DELETE；删除前统一走年库归档 */
    prune() {
        const days = this.retentionDays();
        if (days > 0) {
            const cutoff = new Date(Date.now() - days * 86400e3).toISOString();
            if (this.exportToArchive('fetchedAt < ?', [cutoff])) {
                const r = this.db.prepare('DELETE FROM items WHERE fetchedAt < ?').run(cutoff);
                if (Number(r.changes) > 0)
                    this.log.info(`pruned ${r.changes} expired items (>${days}d)`);
            }
        }
        const over = this.count() - this.maxItems;
        if (over <= 0)
            return;
        let del;
        if (this.pruneLowQuality()) {
            // 质量键=llmScore ?? 5：NULL 视为中档 5——未评分新条目不能被清退饿死
            // （否则它们还没轮到评分就先被删，撞上限后整库冻结）
            const cond = 'id IN (SELECT id FROM items ORDER BY COALESCE(llmScore, 5) ASC, fetchedAt ASC LIMIT ?)';
            del = this.exportToArchive(cond, [over])
                ? Number(this.db.prepare(`DELETE FROM items WHERE ${cond}`).run(over).changes)
                : 0;
        }
        else {
            const cond = 'id IN (SELECT id FROM items ORDER BY fetchedAt ASC LIMIT ?)';
            del = this.exportToArchive(cond, [over])
                ? Number(this.db.prepare(`DELETE FROM items WHERE ${cond}`).run(over).changes)
                : 0;
        }
        this.log.info(`pruned ${del} items (cap ${this.maxItems}${this.pruneLowQuality() ? ', low-quality first' : ''})`);
        if (del > 0)
            this.refreshWindow();
    }
    /** 跨窗口查询（/items 下推）：filter+sort+FTS+分页全在 SQL */
    queryItems(opts) {
        const where = ["json_extract(state,'$.hidden') IS NOT 1"];
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
            where.push('sourceId LIKE ?');
            args.push(`%${opts.source}%`);
        }
        if (opts.unread) {
            where.push("json_extract(state,'$.read') IS NOT 1");
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
        const page = Math.max(1, opts.page ?? 1), size = opts.pageSize ?? 50;
        const total = this.db.prepare(`SELECT COUNT(*) c ${from} WHERE ${where.join(' AND ')}`).get(...args).c;
        const rows = this.db.prepare(`SELECT items.* ${from} WHERE ${where.join(' AND ')} ORDER BY ${key} DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
        return { total, items: rows.map(rowToItem) };
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
        try {
            for await (const line of rl) {
                if (!line.trim())
                    continue;
                const o = JSON.parse(line);
                if (o.type === 'item') {
                    if (ins.run(...itemToRow(o.data)).changes > 0)
                        counts.items++;
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
    /** .db 快照（VACUUM INTO）——全量灾备 */
    snapshot(file) {
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