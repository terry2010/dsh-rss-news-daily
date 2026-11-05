/**
 * webServer 路由：静态阅读器 /dsh-rss-news-daily/ + /api/* JSON 端点。
 * 全部 handler 是原生 req/res；sendJson 统一响应。同源检查拦 cross-site。
 */
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { zonedDayBounds } from './core/time.js';
import { effectiveSources } from './service.js';
import { loopDetectStatus } from './dsh-llm.js';
import { zonedDayKey } from './core/time.js';
import { parseTune, learnFromFeedback } from './core/tune.js';
const BASE = '/dsh-rss-news-daily';
function sendJson(res, status, value) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
}
function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            const buf = c;
            size += buf.length;
            if (size > limit) {
                reject(new Error('body too large'));
                return;
            }
            chunks.push(buf);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            }
            catch {
                resolve({});
            }
        });
        req.on('error', reject);
    });
}
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};
/** 同源防护：拒绝 cross-site 请求（阅读器只服务本实例页面）。 */
function sameSite(req) {
    const site = String(req.headers?.['sec-fetch-site'] || '').toLowerCase();
    return site !== 'cross-site';
}
// === API 端点 ===
function apiItems(deps) {
    return async (req, res) => {
        const u = new URL(req.url || '', 'http://x');
        const day = u.searchParams.get('day') || '';
        const category = u.searchParams.get('category') || '';
        const source = u.searchParams.get('source') || '';
        const q = (u.searchParams.get('q') || '').toLowerCase();
        const unread = u.searchParams.get('unread') === '1';
        const page = Math.max(1, Number(u.searchParams.get('page')) || 1);
        const dayStart = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00`).getTime() : 0;
        const dayEnd = dayStart ? dayStart + 86400e3 : 0;
        let items = deps.store.items;
        if (dayStart)
            items = items.filter((i) => { const t = new Date(i.fetchedAt).getTime(); return t >= dayStart && t < dayEnd; });
        if (category)
            items = items.filter((i) => i.topic === category);
        if (source)
            items = items.filter((i) => i.sourceId === source || i.sourceId.includes(source));
        if (unread)
            items = items.filter((i) => !i.state.read && !i.state.hidden);
        items = items.filter((i) => !i.state.hidden);
        if (q)
            items = items.filter((i) => `${i.title} ${i.summary}`.toLowerCase().includes(q));
        const sortKey = u.searchParams.get('sort') === 'fetched' ? 'fetched' : 'published';
        const qi = deps.store.queryItems;
        if (qi) { // SQLite 后端:filter/sort/FTS/分页全下推
            const b = day ? zonedDayBounds(day, deps.timezone || undefined) : undefined;
            const r = qi.call(deps.store, { day: day || undefined, fetchedAfter: b?.after, fetchedBefore: b?.before, category: category || undefined, source: source || undefined, unread, q: q || undefined, sort: sortKey, page, pageSize: deps.readerPageSize });
            sendJson(res, 200, { ok: true, total: r.total, page, pageSize: deps.readerPageSize, items: r.items });
            return;
        }
        const keyOf = (i) => sortKey === 'fetched' ? i.fetchedAt : (i.publishedAt || i.fetchedAt);
        const sorted = [...items].sort((a, b) => keyOf(b).localeCompare(keyOf(a))); // sort=fetched 按抓取时间;默认按发布时间缺则回退抓取时间
        const pageSize = deps.readerPageSize;
        sendJson(res, 200, {
            ok: true,
            total: sorted.length,
            page,
            pageSize,
            items: sorted.slice((page - 1) * pageSize, page * pageSize).map((i) => ({
                id: i.id, title: i.title, link: i.link, summary: i.summary,
                aiSummary: i.aiSummary, aiSummaryError: i.aiSummaryError, publishedAt: i.publishedAt, fetchedAt: i.fetchedAt,
                sourceId: i.sourceId, topic: i.topic, score: i.score, reasons: i.reasons,
                state: i.state, digestedDay: i.digestedDay,
            })),
        });
    };
}
/** 年库档案：list 扫同目录 archive-YYYY.db；items 只读按年查询（FTS/LIKE+分页，与热库同字段） */
function apiArchive(deps) {
    const dir = () => dirname(deps.store.path);
    return async (req, res) => {
        const u = new URL(req.url || '', 'http://x');
        const tail = (u.pathname.split('/api/archive/')[1] || '').replace(/\/+$/, '');
        if (tail === 'list' || tail === '') {
            const { readdir, stat } = await import('node:fs/promises');
            const { DatabaseSync } = await import('node:sqlite');
            const files = (await readdir(dir()).catch(() => [])).filter((f) => /^archive-\d{4}\.db$/.test(f));
            const out = [];
            for (const f of files) {
                const p = join(dir(), f);
                let n = -1;
                try {
                    const d = new DatabaseSync(p, { readOnly: true });
                    n = d.prepare('SELECT COUNT(*) c FROM items').get().c;
                    d.close();
                }
                catch { /* 打不开给 -1 */ }
                const st = await stat(p).catch(() => null);
                out.push({ file: f, year: f.slice(8, 12), items: n, sizeKB: st ? Math.round(st.size / 1024) : 0 });
            }
            sendJson(res, 200, { ok: true, archives: out.sort((a, b) => b.year.localeCompare(a.year)) });
            return;
        }
        if (tail === 'items') {
            const sp = u.searchParams;
            const year = sp.get('year') || '';
            if (!/^\d{4}$/.test(year)) {
                sendJson(res, 400, { ok: false, error: 'year 必须是 4 位数字' });
                return;
            }
            const { DatabaseSync } = await import('node:sqlite');
            let db;
            try {
                db = new DatabaseSync(join(dir(), `archive-${year}.db`), { readOnly: true });
            }
            catch {
                sendJson(res, 404, { ok: false, error: `无 ${year} 年档案` });
                return;
            }
            try {
                const where = ["json_extract(state,'$.hidden') IS NOT 1"];
                const args = [];
                const cat = sp.get('category'), src = sp.get('source'), q = (sp.get('q') || '').trim();
                if (cat) {
                    where.push('topic = ?');
                    args.push(cat);
                }
                if (src) {
                    where.push('sourceId LIKE ?');
                    args.push(`%${src}%`);
                }
                let from = 'FROM items';
                if (q) {
                    let fts = false;
                    if (q.length >= 3) {
                        try {
                            db.prepare('SELECT rowid FROM items_fts LIMIT 1').get();
                            fts = true;
                        }
                        catch { /* 无 FTS 表 */ }
                    }
                    if (fts) {
                        from = 'FROM items_fts JOIN items ON items.rowid = items_fts.rowid';
                        where.push('items_fts MATCH ?');
                        args.push(`"${q.replace(/"/g, '""')}"`);
                    }
                    else {
                        where.push('(title LIKE ? OR summary LIKE ?)');
                        args.push(`%${q}%`, `%${q}%`);
                    }
                }
                const w = where.join(' AND ');
                const page = Math.max(1, Number(sp.get('page') || 1) | 0);
                const size = deps.readerPageSize;
                const total = db.prepare(`SELECT COUNT(*) c ${from} WHERE ${w}`).get(...args).c;
                const sortKey = sp.get('sort') === 'fetched' ? 'fetchedAt' : "COALESCE(NULLIF(publishedAt,''),fetchedAt)";
                const rows = db.prepare(`SELECT items.* ${from} WHERE ${w} ORDER BY ${sortKey} DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
                const items = rows.map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : undefined, reasons: r.reasons ? JSON.parse(r.reasons) : [], state: r.state ? JSON.parse(r.state) : {} }));
                sendJson(res, 200, { ok: true, total, page, pageSize: size, items });
            }
            finally {
                db.close();
            }
            return;
        }
        sendJson(res, 404, { ok: false, error: 'unknown archive endpoint' });
    };
}
function apiDigest(deps) {
    return async (req, res, day) => {
        const { readFile: rf } = await import('node:fs/promises');
        try {
            const kind = new URL(req.url || '', 'http://x').searchParams.get('kind');
            const file = kind === 'hourly' ? `${day}-hourly.md` : `${day}-rss-briefing.md`;
            const md = await rf(join(deps.digestsDir, file), 'utf8');
            sendJson(res, 200, { ok: true, day, markdown: md });
        }
        catch {
            sendJson(res, 404, { ok: false, error: `no digest for ${day}` });
        }
    };
}
function apiFeedback(deps) {
    return async (req, res) => {
        const body = await readBody(req);
        const item = deps.store.items.find((i) => i.id === body.id);
        if (!item)
            return sendJson(res, 404, { ok: false, error: 'item not found' });
        switch (body.action) {
            case 'read':
                item.state.read = true;
                break;
            case 'unread':
                item.state.read = false;
                break;
            case 'like':
                item.state.liked = 1;
                break;
            case 'dislike':
                item.state.liked = -1;
                break;
            case 'unlike':
                item.state.liked = 0;
                break;
            case 'hide':
                item.state.hidden = true;
                break;
            case 'translate': {
                const tr = await deps.svc.translateItem(item.id);
                if (!tr.ok)
                    return sendJson(res, 400, tr);
                return sendJson(res, 200, { ok: true, state: item.state, translation: tr.translation });
            }
            case 'unhide':
                item.state.hidden = false;
                break;
            default: return sendJson(res, 400, { ok: false, error: `unknown action: ${body.action}` });
        }
        await deps.store.save();
        // 反馈学习：👍/👎 直接微调偏好权重（不进 tuningHistory——反馈不是显式调教）
        if (body.action === 'like' || body.action === 'dislike') {
            const { patch, learned } = learnFromFeedback(deps.prefs.get(), item, body.action);
            deps.prefs.save(patch);
            return sendJson(res, 200, { ok: true, state: item.state, learned });
        }
        sendJson(res, 200, { ok: true, state: item.state });
    };
}
function apiSources(deps) {
    return async (req, res, sub) => {
        const method = String(req.method || 'GET').toUpperCase();
        if (method === 'GET' && !sub) {
            return sendJson(res, 200, {
                ok: true,
                deletedBuiltins: (deps.store.meta.deletedBuiltin || []),
                sources: deps.svc.listSources()
                    .sort((a, b) => (a.builtin === b.builtin ? (a.builtin ? 0 : (b.addedAt || '').localeCompare(a.addedAt || '')) : a.builtin ? 1 : -1)) // 用户源在最上且按添加时间倒序
                    .map((s) => ({
                    id: s.id, url: s.url, title: s.title, category: s.category, tier: s.tier, lang: s.lang,
                    enabled: s.enabled, builtin: s.builtin, summarize: s.summarize, proxy: s.proxy, cooldownHours: s.cooldownHours, health: s.health,
                })),
            });
        }
        if (method === 'POST' && sub === 'preview') { // 预览：验证+抓取不落库，确认后再走 add
            const body = await readBody(req);
            try {
                const pv = await deps.svc.previewSource({ url: String(body.url || ''), title: body.title, category: body.category });
                return sendJson(res, 200, { ok: true, ...pv });
            }
            catch (e) {
                return sendJson(res, 400, { ok: false, error: String(e?.message || e) });
            }
        }
        if (method === 'POST' && !sub) {
            const body = await readBody(req);
            try {
                const src = await deps.svc.addSource({ url: String(body.url || ''), title: body.title, category: body.category });
                return sendJson(res, 200, { ok: true, source: { id: src.id, url: src.url, title: src.title } });
            }
            catch (e) {
                return sendJson(res, 400, { ok: false, error: String(e?.message || e) });
            }
        }
        const id = decodeURIComponent((sub || '').split('?')[0]);
        if (method === 'PATCH') {
            const body = await readBody(req);
            if (body.action === 'restore') {
                const ok = await deps.svc.restoreSource?.(id);
                return sendJson(res, ok ? 200 : 404, { ok: !!ok });
            }
            if (body.action === 'retry') {
                const found = await deps.svc.retrySource(id); // 冷却源手动复活：清 cooldownUntil + failStreak
                return sendJson(res, found ? 200 : 404, { ok: found });
            }
            if (typeof body.enabled === 'boolean')
                await deps.svc.setEnabled(id, body.enabled);
            if (typeof body.summarize === 'boolean')
                await deps.svc.setSummarize(id, body.summarize);
            await deps.svc.updateSource(id, body);
            return sendJson(res, 200, { ok: true });
        }
        if (method === 'DELETE') {
            const removed = await deps.svc.removeSource(id);
            return sendJson(res, removed ? 200 : 404, { ok: removed });
        }
        sendJson(res, 405, { ok: false, error: `unsupported ${method} ${sub}` });
    };
}
function apiOpml(deps) {
    return async (req, res) => {
        const method = String(req.method || 'GET').toUpperCase();
        if (method === 'GET') {
            const opml = await deps.svc.exportOpml();
            res.statusCode = 200;
            res.setHeader('content-type', 'text/xml; charset=utf-8');
            res.setHeader('content-disposition', 'attachment; filename="dsh-rss-news-daily.opml"');
            res.end(opml);
            return;
        }
        if (method === 'POST') {
            const body = await readBody(req, 4 * 1024 * 1024);
            try {
                const r = await deps.svc.importOpml(String(body.opml || ''));
                return sendJson(res, 200, { ok: true, ...r });
            }
            catch (e) {
                return sendJson(res, 400, { ok: false, error: String(e?.message || e) });
            }
        }
        sendJson(res, 405, { ok: false, error: `unsupported ${method}` });
    };
}
function apiPrefs(deps) {
    return async (req, res) => {
        const method = String(req.method || 'GET').toUpperCase();
        if (method === 'GET')
            return sendJson(res, 200, { ok: true, prefs: deps.prefs.get() });
        if (method === 'POST') {
            const body = await readBody(req);
            // 只落显式给出的字段——undefined 会让 normalizePrefs 把已学权重清成默认
            const patch = Object.fromEntries(Object.entries({
                topics: body.topics, keywords: body.keywords,
                bannedKeywords: body.bannedKeywords, sourceWeight: body.sourceWeight,
                proxyUrl: body.proxyUrl, autoTranslate: body.autoTranslate,
                showNavEntry: body.showNavEntry, loopGuard: body.loopGuard, backup: body.backup,
                digestOpts: body.digestOpts, subscribedTopics: body.subscribedTopics,
            }).filter(([, v]) => v !== undefined));
            deps.prefs.save(patch);
            return sendJson(res, 200, { ok: true, prefs: deps.prefs.get() });
        }
        sendJson(res, 405, { ok: false, error: `unsupported ${method}` });
    };
}
/** /api/llm：GET 列 provider（?provider=p 时列其 model）；POST 设/清 UI 模型覆盖 */
function apiLlm(deps) {
    return async (req, res) => {
        const method = String(req.method || 'GET').toUpperCase();
        const runtime = deps.getLlm?.();
        const ui = deps.prefs.get().llm;
        const cfg = deps.configLlm;
        const effective = ui?.provider && ui?.model ? 'ui' : (cfg?.provider && cfg?.model ? 'config' : 'auto');
        const current = effective === 'ui' ? ui : effective === 'config' ? cfg : { provider: '', model: '' };
        if (method === 'GET') {
            if (!runtime)
                return sendJson(res, 200, { ok: true, available: false, providers: [], models: [], current, effective });
            const u = new URL(req.url || '', 'http://x');
            const provider = u.searchParams.get('provider') || '';
            const providers = runtime.listProviders().map((p) => ({ id: p.id }));
            let models = [];
            if (provider) {
                models = (await runtime.listModels(provider).catch(() => [])).map((m) => m.id);
            }
            return sendJson(res, 200, { ok: true, available: true, providers, models, current, effective });
        }
        if (method === 'POST') {
            const body = await readBody(req);
            const provider = String(body.provider || '').trim();
            const model = String(body.model || '').trim();
            if (body.scope === 'translate') {
                if (provider && model)
                    deps.prefs.save({ translateLlm: { provider, model } });
                else
                    deps.prefs.save({ translateLlm: undefined });
                return sendJson(res, 200, { ok: true, translateLlm: deps.prefs.get().translateLlm });
            }
            if (provider && model)
                deps.prefs.save({ llm: { provider, model } });
            else
                deps.prefs.save({ llm: undefined }); // 空对 = 清除覆盖回自动
            return sendJson(res, 200, { ok: true, llm: deps.prefs.get().llm });
        }
        sendJson(res, 405, { ok: false, error: `unsupported ${method}` });
    };
}
async function serveStatic(res, rel) {
    const webDir = join(fileURLToPath(new URL('.', import.meta.url)), 'web');
    const safe = rel.split('?')[0].replace(/^\/+|\.{2,}/g, '') || 'index.html';
    const file = join(webDir, safe);
    try {
        const body = await readFile(file);
        res.statusCode = 200;
        res.setHeader('content-type', MIME[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream');
        res.end(body);
    }
    catch {
        res.statusCode = 404;
        res.end('not found');
    }
}
/** 注册阅读器全部路由；返回 disposer。MOUNT 于 ctx.inject(['webServer']) 内调用。 */
export function mountApi(ws, deps) {
    const disposers = [];
    const guard = (fn) => (req, res) => {
        if (!sameSite(req)) {
            res.statusCode = 403;
            res.end('forbidden');
            return Promise.resolve();
        }
        return Promise.resolve(fn(req, res)).catch((e) => sendJson(res, 500, { ok: false, error: String(e) }));
    };
    // 静态页（exact 匹配目录入口 + prefix 资源）
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/`, handler: guard((_q, r) => serveStatic(r, 'index.html')) }));
    disposers.push(ws.register({ kind: 'exact', path: BASE, handler: guard((_q, r) => serveStatic(r, 'index.html')) }));
    // 宿主 prefix 语义 = 精确命中 p 或 p/<x>；注册必须不带尾斜杠（否则要求双斜杠才中）
    disposers.push(ws.register({ kind: 'prefix', path: `${BASE}/web`, handler: guard((q, r) => serveStatic(r, (q.url || '').replace(`${BASE}/web/`, ''))) }));
    // JSON API
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/items`, handler: guard(apiItems(deps)) }));
    disposers.push(ws.register({ kind: 'prefix', path: `${BASE}/api/archive`, handler: guard(apiArchive(deps)) }));
    disposers.push(ws.register({ kind: 'prefix', path: `${BASE}/api/digest`, handler: guard((q, r) => apiDigest(deps)(q, r, ((q.url || '').split('/').pop() || '').split('?')[0] || zonedDayKey(new Date(), deps.timezone))) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/digest`, handler: guard((q, r) => apiDigest(deps)(q, r, zonedDayKey(new Date(), deps.timezone))) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/digest-stop`, handler: guard(async (q, r) => { if (q.method !== 'POST') {
            r.statusCode = 405;
            r.end();
            return;
        } sendJson(r, 200, { ok: true, result: await deps.svc.stopDigest?.() }); }) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/feedback`, handler: guard(apiFeedback(deps)) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/sources`, handler: guard((q, r) => apiSources(deps)(q, r, '')) }));
    disposers.push(ws.register({ kind: 'prefix', path: `${BASE}/api/sources`, handler: guard((q, r) => apiSources(deps)(q, r, (q.url || '').replace(`${BASE}/api/sources`, '').replace(/^\//, ''))) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/opml`, handler: guard(apiOpml(deps)) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/opml-export`, handler: guard(async (_q, r) => {
            // guest webview 会话禁了 will-download——文件落盘是插件侧唯一可靠的"下载"
            const { writeFile, mkdir } = await import('node:fs/promises');
            const { join, dirname } = await import('node:path');
            const dir = join(dirname(deps.store.path), 'exports');
            await mkdir(dir, { recursive: true });
            const file = join(dir, `dsh-rss-news-daily-sources-${new Date().toISOString().slice(0, 10)}.opml`);
            await writeFile(file, await deps.svc.exportOpml(), 'utf8');
            sendJson(r, 200, { ok: true, path: file });
        }) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/prefs`, handler: guard(apiPrefs(deps)) }));
    // 手动备份：rss-backup-<stamp>/ = store.db 快照 + digests/ + prefs.json，超额删最旧
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/backup`, handler: guard(async (_q, r) => {
            const b = deps.prefs.get().backup;
            if (!b?.dir) {
                sendJson(r, 400, { ok: false, error: '先在设置里填备份文件夹' });
                return;
            }
            try {
                const bdir = join(b.dir.replace(/^~(?=$|\/)/, homedir()));
                const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
                const dest = join(bdir, `rss-backup-${stamp}`);
                await mkdir(dest, { recursive: true });
                deps.store.snapshot?.(join(dest, 'store.db'));
                const dd = dirname(deps.store.path);
                await cp(join(dd, 'digests'), join(dest, 'digests'), { recursive: true }).catch(() => { });
                await copyFile(join(dd, 'prefs.json'), join(dest, 'prefs.json')).catch(() => { });
                const keep = Math.max(1, b.keep ?? 7);
                const entries = (await readdir(bdir)).filter((n) => n.startsWith('rss-backup-')).sort();
                for (const old of entries.slice(0, Math.max(0, entries.length - keep)))
                    await rm(join(bdir, old), { recursive: true, force: true }).catch(() => { });
                sendJson(r, 200, { ok: true, file: dest });
            }
            catch (e) {
                sendJson(r, 500, { ok: false, error: String(e?.message || e) });
            }
        }) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/loopguard`, handler: guard(async (_q, r) => {
            const nm = dirname(fileURLToPath(new URL('../', import.meta.url))); // 包根的上级 = node_modules/
            const installed = existsSync(join(nm, 'dsh-loop-recover', 'package.json'));
            let enabled = false;
            if (installed) {
                try {
                    const profPkg = JSON.parse(await readFile(join(nm, '..', 'package.json'), 'utf8'));
                    enabled = (profPkg.dsh?.profile?.bundles ?? []).includes('dsh-loop-recover');
                    const patch = await readFile(join(nm, '..', 'cordis.patch.yml'), 'utf8').catch(() => '');
                    // 按条目块判断：disabled 必须落在 loop-recover 自己的块里（下一条目的 disabled 会误伤）
                    const block = patch.split(/^- id:/m).find((b) => /^\s*loop-recover\b/.test(b));
                    if (block && /disabled:\s*true/.test(block))
                        enabled = false;
                }
                catch { /* 读不到 profile 则按未启用 */ }
            }
            sendJson(r, 200, { ok: true, installed, enabled, pref: deps.prefs.get().loopGuard ?? null, active: loopDetectStatus() === 'active' });
        }) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/llm`, handler: guard(apiLlm(deps)) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/schedule`, handler: guard(async (q, r) => {
            const method = String(q.method || 'GET').toUpperCase();
            const ui = deps.prefs.get().schedule;
            const def = deps.configSchedule ?? { digestTimes: [], fetchTimes: [] };
            if (method === 'GET') {
                return sendJson(r, 200, { ok: true, effective: ui ? 'ui' : 'config', schedule: ui ?? def });
            }
            if (method === 'POST') {
                const body = await readBody(q);
                if (body.clear)
                    deps.prefs.save({ schedule: undefined });
                else {
                    deps.prefs.save({ schedule: {
                            digestTimes: Array.isArray(body.digestTimes) ? body.digestTimes : [],
                            fetchTimes: Array.isArray(body.fetchTimes) ? body.fetchTimes : [],
                            ...(typeof body.intervalMinutes === 'number' && body.intervalMinutes > 0 ? { intervalMinutes: body.intervalMinutes } : {}),
                            ...(typeof body.onStartup === 'boolean' ? { onStartup: body.onStartup } : {}),
                        } });
                }
                return sendJson(r, 200, { ok: true, schedule: deps.prefs.get().schedule ?? def });
            }
            sendJson(r, 405, { ok: false, error: `unsupported ${method}` });
        }) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/tune`, handler: guard(async (q, r) => {
            const body = await readBody(q);
            const res2 = parseTune(String(body.text || ''), deps.prefs.get());
            if (res2.ok && res2.patch) {
                deps.prefs.applyTune(String(body.text || ''), res2.actions.map((a) => `${a.kind}:${a.target}`), res2.patch);
            }
            sendJson(r, res2.ok ? 200 : 400, { ok: res2.ok, error: res2.error, actions: res2.actions.map((a) => `${a.kind}:${a.target}${a.factor ? `×${a.factor}` : ''}`), prefs: deps.prefs.get() });
        }) }));
    const postOnly = (q) => String(q.method || 'GET').toUpperCase() === 'POST';
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/fetch`, handler: guard(async (q, r) => {
            if (!postOnly(q))
                return sendJson(r, 405, { ok: false, error: 'use POST' });
            const body = await readBody(q);
            // fire-and-forget：autoTranslate 串行翻译远超 HTTP 超时,立即返回+前端轮询 /fetch-progress
            deps.svc.runFetch(!!body?.force, !!body?.onlyFailed, { source: body?.source, category: body?.category })
                .catch(() => { });
            sendJson(r, 200, { ok: true, started: true });
        }) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/digests/clear`, handler: guard(async (q, r) => {
            if (!postOnly(q))
                return sendJson(r, 405, { ok: false, error: 'use POST' });
            const { readdir, unlink } = await import('node:fs/promises');
            let deleted = 0;
            let files;
            try {
                files = await readdir(deps.digestsDir);
            }
            catch (e) {
                if (e.code === 'ENOENT')
                    files = [];
                else
                    throw e;
            }
            for (const f of files) {
                if (!f.endsWith('.md'))
                    continue; // 只清日报/快报,index.json 等保留
                await unlink(join(deps.digestsDir, f));
                deleted += 1;
            }
            sendJson(r, 200, { ok: true, deleted });
        }) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/items/clear`, handler: guard(async (q, r) => {
            if (!postOnly(q))
                return sendJson(r, 405, { ok: false, error: 'use POST' });
            const deleted = deps.store.clearItems();
            deps.store.meta.lastFetchAdded = 0; // 上轮新增计数同步归零
            await deps.store.save();
            sendJson(r, 200, { ok: true, deleted });
        }) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/fetch-progress`, handler: guard(async (_q, r) => sendJson(r, 200, { ok: true, ...(await deps.svc.fetchProgress?.() ?? { running: false, done: 0, total: 0 }) })) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/digest-progress`, handler: guard(async (_q, r) => sendJson(r, 200, { ok: true, ...(await deps.svc.digestProgress?.() ?? { running: false, done: 0, total: 0 }) })) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/fetch-test`, handler: guard(async (q, r) => {
            const u = new URL(q.url || '/', 'http://x').searchParams;
            const url = u.get('url') || '';
            if (!/^https?:\/\//.test(url)) {
                sendJson(r, 400, { ok: false, error: '需要 http(s) URL' });
                return;
            }
            const pv = u.get('proxy');
            const res = await deps.svc.testFetch(url, pv === '1' || pv === 'true' ? true : undefined);
            sendJson(r, 200, { ok: !('error' in res) || res.error === undefined, ...res });
        }) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/fetch-cancel`, handler: guard(async (q, r) => { if (q.method !== 'POST') {
            r.statusCode = 405;
            r.end();
            return;
        } sendJson(r, 200, { ok: true, result: await deps.svc.cancelFetch?.() }); }) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/digest-run`, handler: guard(async (q, r) => {
            if (!postOnly(q))
                return sendJson(r, 405, { ok: false, error: 'use POST' });
            const body = await readBody(q);
            const day = /^\d{4}-\d{2}-\d{2}$/.test(body?.day || '') ? body.day : undefined;
            // fire-and-forget：大 digestItems 下 LLM 全链路远超 HTTP 请求超时，
            // 改为立即返回 + 前端轮询 /digest-progress 收尾
            deps.runDigest(!!body?.force, day).catch(() => { });
            sendJson(r, 200, { ok: true, started: true });
        }) }));
    // P7 导出/导入：NDJSON 流式 bundle + .db 快照
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/export`, handler: guard(async (q, r) => {
            const st = deps.store;
            if (!st.exportNdjson)
                return sendJson(r, 400, { ok: false, error: 'sqlite backend required' });
            const u = new URL(q.url || '', 'http://x');
            const kind = u.searchParams.get('kind') || 'ndjson'; // ndjson | db
            const scope = (u.searchParams.get('scope') || 'all');
            const dir = join(dirname(deps.store.path), 'exports');
            const file = join(dir, kind === 'db' ? `store-${Date.now()}.db` : `rss-export-${Date.now()}.ndjson`);
            if (kind === 'db') {
                st.snapshot(file);
                return sendJson(r, 200, { ok: true, file });
            }
            const n = await st.exportNdjson(file, deps.digestsDir, scope);
            sendJson(r, 200, { ok: true, file, items: n });
        }) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/import`, handler: guard(async (q, r) => {
            if (q.method !== 'POST') {
                r.statusCode = 405;
                r.end();
                return;
            }
            const st = deps.store;
            if (!st.importNdjson)
                return sendJson(r, 400, { ok: false, error: 'sqlite backend required' });
            const body = await readBody(q);
            if (!body.path)
                return sendJson(r, 400, { ok: false, error: 'path required' });
            const counts = await st.importNdjson(body.path, deps.digestsDir);
            sendJson(r, 200, { ok: true, ...counts });
        }) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/status`, handler: guard((_q, r) => sendJson(r, 200, { ok: true, ...deps.svc.status() })) }));
    return () => disposers.forEach((d) => d());
}
//# sourceMappingURL=api.js.map