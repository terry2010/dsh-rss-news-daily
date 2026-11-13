/**
 * webServer 路由：静态阅读器 /dsh-rss-news-daily/ + /api/* JSON 端点。
 * 全部 handler 是原生 req/res；sendJson 统一响应。同源检查拦 cross-site。
 */

import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir, platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { zonedDayBounds } from './core/time.js'

import type { StoreLike } from './core/store.js'
import type { PrefsStore } from './core/prefs.js'
import type { NewsService } from './tools.js'
import { effectiveSources } from './service.js'
import { loopDetectStatus } from './dsh-llm.js'
import { backupDirOf, runBackupZip, stageRestore } from './backup.js'
import { zonedDayKey } from './core/time.js'
import { parseTune, learnFromFeedback } from './core/tune.js'
import { normalizeTopicParams, listTopics, deleteTopic, exportTopic, topicsDirOf, type TopicParams } from './topic-pipeline.js'

const BASE = '/dsh-rss-news-daily'

interface Req {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  on(ev: string, cb: (c?: unknown) => void): void
}
interface Res {
  statusCode: number
  setHeader(k: string, v: string): void
  end(b?: string): void
}

interface WebServerLike {
  register(opts: { kind: string; path: string; handler: (req: Req, res: Res) => void }): () => void
}

function sendJson(res: Res, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

function readBody(req: Req, limit = 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: unknown) => {
      const buf = c as Buffer
      size += buf.length
      if (size > limit) { reject(new Error('body too large')); return }
      chunks.push(buf)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** 同源防护：拒绝 cross-site 请求（阅读器只服务本实例页面）。 */
function sameSite(req: Req): boolean {
  const site = String(req.headers?.['sec-fetch-site'] || '').toLowerCase()
  return site !== 'cross-site'
}

export interface ApiDeps {
  store: StoreLike
  prefs: PrefsStore
  svc: NewsService
  configSources: Array<{ url: string; title?: string; category?: string; enabled?: boolean }>
  timezone: string
  readerPageSize: number
  digestsDir: string
  runDigest: (force?: boolean, day?: string) => Promise<unknown>
  /** 宿主 LLM runtime（可选能力）；用于 /api/llm 列 provider/model */
  getLlm?: () => { listProviders(): Array<{ id: string }>; listModels(p: string): Promise<Array<{ id: string }>> } | undefined
  /** 宿主目录选择服务（可选能力）；native 能力弹系统对话框，browse/缺失时 pick-dir 返回 supported:false */
  getDirectoryPicker?: () => { capability?: () => { kind?: string; pick?: (s: AbortSignal) => Promise<string | null> } } | undefined
  /** config 层的 llm 路由对（用于 effective 判定展示） */
  configLlm?: { provider: string; model: string }
  /** config 层的调度默认（UI 覆盖的回落） */
  configSchedule?: { digestTimes: string[]; fetchTimes: string[] }
  /** 开发日志目录（prefs.devLog 开启时 LLM 全量对话 JSONL 落这里） */
  devlogDir?: string
  /** 页面活跃心跳：每个 API/静态请求都打一下——无心跳=页面已关（statusbar 2s 轮询天然是心跳） */
  onApiHit?: () => void
  /** 用户真实手势信号：前端只在最近 60s 内有鼠标/键盘/滚动/触屏交互时在 status 轮询上带 act=1——区分"页面挂机"和"人在用" */
  onGesture?: () => void
}

// === API 端点 ===

function apiItems(deps: ApiDeps) {
  return async (req: Req, res: Res) => {
    const u = new URL(req.url || '', 'http://x')
    const day = u.searchParams.get('day') || ''
    const category = u.searchParams.get('category') || ''
    const source = u.searchParams.get('source') || ''
    const q = (u.searchParams.get('q') || '').toLowerCase()
    const unread = u.searchParams.get('unread') === '1'
    const page = Math.max(1, Number(u.searchParams.get('page')) || 1)
    const dayStart = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00`).getTime() : 0
    const dayEnd = dayStart ? dayStart + 86400e3 : 0
    let items = deps.store.items
    if (dayStart) items = items.filter((i) => { const t = new Date(i.fetchedAt).getTime(); return t >= dayStart && t < dayEnd })
    if (category) items = items.filter((i) => i.topic === category)
    if (source) items = items.filter((i) => i.sourceId === source || i.sourceId.includes(source))
    if (unread) items = items.filter((i) => !i.state.read && !i.state.hidden)
    items = items.filter((i) => !i.state.hidden)
    if (q) items = items.filter((i) => `${i.title} ${i.summary}`.toLowerCase().includes(q))
    const sortKey = u.searchParams.get('sort') === 'fetched' ? 'fetched' : 'published'
    const qi = (deps.store as { queryItems?: (o: { day?: string; category?: string; source?: string; unread?: boolean; q?: string; sort?: string; page?: number; pageSize?: number }) => { total: number; items: typeof items } }).queryItems
    if (qi) { // SQLite 后端:filter/sort/FTS/分页全下推
      const b = day ? zonedDayBounds(day, deps.timezone || undefined) : undefined
      const r = qi.call(deps.store, { day: day || undefined, fetchedAfter: b?.after, fetchedBefore: b?.before, category: category || undefined, source: source || undefined, unread, q: q || undefined, sort: sortKey, page, pageSize: deps.readerPageSize })
      sendJson(res, 200, { ok: true, total: r.total, page, pageSize: deps.readerPageSize, items: r.items })
      return
    }
    const keyOf = (i: (typeof items)[number]) => sortKey === 'fetched' ? i.fetchedAt : (i.publishedAt || i.fetchedAt)
    const sorted = [...items].sort((a, b) => keyOf(b).localeCompare(keyOf(a))) // sort=fetched 按抓取时间;默认按发布时间缺则回退抓取时间
    const pageSize = deps.readerPageSize
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
    })
  }
}

/** 年库档案：list 扫同目录 archive-YYYY.db；items 只读按年查询（FTS/LIKE+分页，与热库同字段） */
function apiArchive(deps: ApiDeps) {
  const dir = () => dirname(deps.store.path)
  return async (req: Req, res: Res) => {
    const u = new URL(req.url || '', 'http://x')
    const tail = (u.pathname.split('/api/archive/')[1] || '').replace(/\/+$/, '')
    if (tail === 'list' || tail === '') {
      const { readdir, stat } = await import('node:fs/promises')
      const { DatabaseSync } = await import('node:sqlite')
      const files = (await readdir(dir()).catch(() => [])).filter((f) => /^archive-\d{4}\.db$/.test(f))
      const out: Array<{ file: string; year: string; items: number; sizeKB: number }> = []
      for (const f of files) {
        const p = join(dir(), f)
        let n = -1
        try { const d = new DatabaseSync(p, { readOnly: true }); n = (d.prepare('SELECT COUNT(*) c FROM items').get() as { c: number }).c; d.close() } catch { /* 打不开给 -1 */ }
        const st = await stat(p).catch(() => null)
        out.push({ file: f, year: f.slice(8, 12), items: n, sizeKB: st ? Math.round(st.size / 1024) : 0 })
      }
      sendJson(res, 200, { ok: true, archives: out.sort((a, b) => b.year.localeCompare(a.year)) })
      return
    }
    if (tail === 'items') {
      const sp = u.searchParams
      const year = sp.get('year') || ''
      if (!/^\d{4}$/.test(year)) { sendJson(res, 400, { ok: false, error: 'year 必须是 4 位数字' }); return }
      const { DatabaseSync } = await import('node:sqlite')
      let db: InstanceType<typeof DatabaseSync>
      try { db = new DatabaseSync(join(dir(), `archive-${year}.db`), { readOnly: true }) }
      catch { sendJson(res, 404, { ok: false, error: `无 ${year} 年档案` }); return }
      try {
        const where: string[] = ["json_extract(state,'$.hidden') IS NOT 1"]
        const args: Array<string | number> = []
        const cat = sp.get('category'), src = sp.get('source'), q = (sp.get('q') || '').trim()
        if (cat) { where.push('topic = ?'); args.push(cat) }
        if (src) { where.push('sourceId LIKE ?'); args.push(`%${src}%`) }
        let from = 'FROM items'
        if (q) {
          let fts = false
          if (q.length >= 3) { try { db.prepare('SELECT rowid FROM items_fts LIMIT 1').get(); fts = true } catch { /* 无 FTS 表 */ } }
          if (fts) { from = 'FROM items_fts JOIN items ON items.rowid = items_fts.rowid'; where.push('items_fts MATCH ?'); args.push(`"${q.replace(/"/g, '""')}"`) }
          else { where.push('(title LIKE ? OR summary LIKE ?)'); args.push(`%${q}%`, `%${q}%`) }
        }
        const w = where.join(' AND ')
        const page = Math.max(1, Number(sp.get('page') || 1) | 0)
        const size = deps.readerPageSize
        const total = (db.prepare(`SELECT COUNT(*) c ${from} WHERE ${w}`).get(...args) as { c: number }).c
        const sortKey = sp.get('sort') === 'fetched' ? 'fetchedAt' : "COALESCE(NULLIF(publishedAt,''),fetchedAt)"
        const rows = db.prepare(`SELECT items.* ${from} WHERE ${w} ORDER BY ${sortKey} DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size) as Array<Record<string, unknown>>
        const items = rows.map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags as string) : undefined, reasons: r.reasons ? JSON.parse(r.reasons as string) : [], state: r.state ? JSON.parse(r.state as string) : {} }))
        sendJson(res, 200, { ok: true, total, page, pageSize: size, items })
      } finally { db.close() }
      return
    }
    sendJson(res, 404, { ok: false, error: 'unknown archive endpoint' })
  }
}

function apiDigest(deps: ApiDeps) {
  return async (req: Req, res: Res, day: string) => {
    const { readFile: rf } = await import('node:fs/promises')
    try {
      const kind = new URL(req.url || '', 'http://x').searchParams.get('kind')
      const file = kind === 'hourly' ? `${day}-hourly.md` : `${day}-rss-briefing.md`
      const md = await rf(join(deps.digestsDir, file), 'utf8')
      sendJson(res, 200, { ok: true, day, markdown: md })
    } catch {
      sendJson(res, 404, { ok: false, error: `no digest for ${day}` })
    }
  }
}

function apiFeedback(deps: ApiDeps) {
  return async (req: Req, res: Res) => {
    const body = await readBody(req) as { id?: string; action?: string }
    const item = deps.store.items.find((i) => i.id === body.id)
    if (!item) return sendJson(res, 404, { ok: false, error: 'item not found' })
    switch (body.action) {
      case 'read': item.state.read = true; break
      case 'unread': item.state.read = false; break
      case 'like': item.state.liked = 1; break
      case 'dislike': item.state.liked = -1; break
      case 'unlike': item.state.liked = 0; break
      case 'hide': item.state.hidden = true; break
      case 'translate': {
        const tr = await deps.svc.translateItem!(item.id)
        if (!tr.ok) return sendJson(res, 400, tr)
        return sendJson(res, 200, { ok: true, state: item.state, translation: tr.translation })
      }
      case 'unhide': item.state.hidden = false; break
      default: return sendJson(res, 400, { ok: false, error: `unknown action: ${body.action}` })
    }
    await deps.store.save()
    // 反馈学习：👍/👎 直接微调偏好权重（不进 tuningHistory——反馈不是显式调教）
    if (body.action === 'like' || body.action === 'dislike') {
      const { patch, learned } = learnFromFeedback(deps.prefs.get(), item, body.action)
      deps.prefs.save(patch)
      return sendJson(res, 200, { ok: true, state: item.state, learned })
    }
    sendJson(res, 200, { ok: true, state: item.state })
  }
}

function apiSources(deps: ApiDeps) {
  return async (req: Req, res: Res, sub: string) => {
    const method = String(req.method || 'GET').toUpperCase()
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
      })
    }
    if (method === 'POST' && sub === 'preview') { // 预览：验证+抓取不落库，确认后再走 add
      const body = await readBody(req) as { url?: string; title?: string; category?: string }
      try {
        const pv = await deps.svc.previewSource!({ url: String(body.url || ''), title: body.title, category: body.category })
        return sendJson(res, 200, { ok: true, ...pv })
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String((e as Error)?.message || e) })
      }
    }
    if (method === 'POST' && !sub) {
      const body = await readBody(req) as { url?: string; title?: string; category?: string }
      try {
        const src = await deps.svc.addSource({ url: String(body.url || ''), title: body.title, category: body.category })
        return sendJson(res, 200, { ok: true, source: { id: src.id, url: src.url, title: src.title } })
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String((e as Error)?.message || e) })
      }
    }
    const id = decodeURIComponent((sub || '').split('?')[0])
    if (method === 'PATCH') {
      const body = await readBody(req) as { enabled?: boolean; title?: string; action?: string; summarize?: boolean; category?: string; proxy?: string | boolean | null; cooldownHours?: number | null }
      if (body.action === 'restore') {
        const ok = await (deps.svc as { restoreSource?: (u: string) => Promise<boolean> }).restoreSource?.(id)
        return sendJson(res, ok ? 200 : 404, { ok: !!ok })
      }
      if (body.action === 'retry') {
        const found = await deps.svc.retrySource(id) // 冷却源手动复活：清 cooldownUntil + failStreak
        return sendJson(res, found ? 200 : 404, { ok: found })
      }
      if (typeof body.enabled === 'boolean') await deps.svc.setEnabled(id, body.enabled)
      if (typeof body.summarize === 'boolean') await deps.svc.setSummarize(id, body.summarize)
      await deps.svc.updateSource(id, body as Record<string, unknown>)
      return sendJson(res, 200, { ok: true })
    }
    if (method === 'DELETE') {
      const removed = await deps.svc.removeSource(id)
      return sendJson(res, removed ? 200 : 404, { ok: removed })
    }
    sendJson(res, 405, { ok: false, error: `unsupported ${method} ${sub}` })
  }
}

/** AI 专题：列表/详情/生成/预览/再生成/导出/删除。读操作走 topics/ 目录文件；写操作经 svc。 */
function apiTopics(deps: ApiDeps) {
  const activeIds = async () => { // 在跑+排队的 id：列表懒修复要放行它们（不能把自己修成 error）
    const p = deps.svc.topicProgress ? await deps.svc.topicProgress().catch(() => undefined) : undefined
    return { activeId: p?.running ? (p.id || '') : '', queuedIds: p?.queuedIds || [] }
  }
  return async (req: Req, res: Res, sub: string) => {
    const method = String(req.method || 'GET').toUpperCase()
    const parts = sub.split('/').filter(Boolean) // '' | '<id>' | '<id>/<act>' | 'preview'
    // GET /api/topics —— 列表（generating/queued 懒修复，排除在跑的与在内存队列里的）
    if (method === 'GET' && parts.length === 0) {
      const topics = await listTopics(deps.digestsDir, await activeIds())
      return sendJson(res, 200, { ok: true, topics })
    }
    // POST /api/topics —— 校验后同步落 generating/queued 元数据，fire-and-forget；busy 时进内存队列
    if (method === 'POST' && parts.length === 0) {
      const norm = normalizeTopicParams(await readBody(req))
      if (!norm.ok) return sendJson(res, 400, { ok: false, error: norm.error })
      if (!deps.svc.runTopic) return sendJson(res, 501, { ok: false, error: 'topic service unavailable' })
      const r = await deps.svc.runTopic(norm.params)
      return sendJson(res, r.ok ? 200 : 409, r)
    }
    // POST /api/topics/preview —— 只读候选预览；不调 LLM、不受生成锁限制；page 翻页入文集
    if (method === 'POST' && parts[0] === 'preview' && parts.length === 1) {
      const body = await readBody(req)
      const norm = normalizeTopicParams(body)
      if (!norm.ok) return sendJson(res, 400, { ok: false, error: norm.error })
      if (!deps.svc.previewTopic) return sendJson(res, 501, { ok: false, error: 'topic service unavailable' })
      const page = typeof (body as { page?: unknown }).page === 'number' ? (body as { page: number }).page : 1
      const filterSourceId = typeof (body as { filterSourceId?: unknown }).filterSourceId === 'string' && (body as { filterSourceId: string }).filterSourceId
        ? (body as { filterSourceId: string }).filterSourceId : undefined
      const r = await deps.svc.previewTopic(norm.params, page, filterSourceId)
      return sendJson(res, 200, { ok: true, ...r })
    }
    const id = parts[0] || ''
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) return sendJson(res, 404, { ok: false, error: 'unknown topics endpoint' })
    const act = parts[1] || ''
    // GET /api/topics/:id —— {meta, markdown?}；generating/queued/error 无 markdown，前端渲状态卡
    if (method === 'GET' && !act) {
      const meta = (await listTopics(deps.digestsDir, await activeIds())).find((m) => m.id === id)
      if (!meta) return sendJson(res, 404, { ok: false, error: 'not found' })
      // markdown 只要落过盘就返回——重生成/排队/失败期间旧版仍可读，前端按 meta.status 叠状态条
      const markdown = await readFile(join(topicsDirOf(deps.digestsDir), `${id}.md`), 'utf8').catch(() => undefined)
      return sendJson(res, 200, { ok: true, meta, ...(markdown !== undefined ? { markdown } : {}) })
    }
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: `unsupported ${method}` })
    // 写动作与列表同口径：listTopics+activeIds——僵死 generating/queued 先修成 error（可删可再生），真在跑/排队的才挡住
    const metas = await listTopics(deps.digestsDir, await activeIds())
    const meta = metas.find((m) => m.id === id)
    if (!meta) return sendJson(res, 404, { ok: false, error: 'not found' })
    if (act === 'regen') { // 覆盖重生成：body 带 keywords=修改专题按新参数重跑，空 body=沿用 meta 参数；generating/queued 行禁用
      if (meta.status === 'generating' || meta.status === 'queued') return sendJson(res, 409, { ok: false, error: '生成中/排队中不可重生成' })
      if (!deps.svc.regenTopic) return sendJson(res, 501, { ok: false, error: 'topic service unavailable' })
      const body = await readBody(req).catch(() => ({})) as Record<string, unknown>
      let params: TopicParams | undefined
      if (Array.isArray(body.keywords)) { // 修改专题提交：整包新参数归一化后落 meta 重跑
        const n = normalizeTopicParams(body)
        if (!n.ok) return sendJson(res, 400, { ok: false, error: n.error })
        params = n.params
      }
      const r = await deps.svc.regenTopic(id, params)
      return sendJson(res, r.ok ? 200 : 409, r)
    }
    if (act === 'delete') { // 前端二次确认已到才到；generating 行禁用；queued 先摘内存队列再删档
      if (meta.status === 'generating') return sendJson(res, 409, { ok: false, error: '生成中不可删除' })
      if (meta.status === 'queued') deps.svc.dequeueTopic?.(id)
      await deleteTopic(deps.digestsDir, id)
      return sendJson(res, 200, { ok: true })
    }
    if (act === 'export') {
      if (meta.status !== 'done') return sendJson(res, 409, { ok: false, error: '仅已完成的专题可导出' })
      const body = await readBody(req) as { dir?: string }
      const target = (typeof body.dir === 'string' && body.dir.trim()) ? body.dir.trim() : join(dirname(deps.store.path), 'exports')
      try {
        const file = await exportTopic(deps.digestsDir, id, target)
        return sendJson(res, 200, { ok: true, file })
      } catch (e) { return sendJson(res, 500, { ok: false, error: String((e as Error)?.message || e) }) }
    }
    sendJson(res, 404, { ok: false, error: 'unknown topics endpoint' })
  }
}

function apiOpml(deps: ApiDeps) {
  return async (req: Req, res: Res) => {
    const method = String(req.method || 'GET').toUpperCase()
    if (method === 'GET') {
      const opml = await deps.svc.exportOpml()
      res.statusCode = 200
      res.setHeader('content-type', 'text/xml; charset=utf-8')
      res.setHeader('content-disposition', 'attachment; filename="dsh-rss-news-daily.opml"')
      res.end(opml)
      return
    }
    if (method === 'POST') {
      const body = await readBody(req, 4 * 1024 * 1024) as { opml?: string }
      try {
        const r = await deps.svc.importOpml(String(body.opml || ''))
        return sendJson(res, 200, { ok: true, ...r })
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String((e as Error)?.message || e) })
      }
    }
    sendJson(res, 405, { ok: false, error: `unsupported ${method}` })
  }
}

function apiPrefs(deps: ApiDeps) {
  return async (req: Req, res: Res) => {
    const method = String(req.method || 'GET').toUpperCase()
    if (method === 'GET') return sendJson(res, 200, { ok: true, prefs: deps.prefs.get() })
    if (method === 'POST') {
      const body = await readBody(req) as Partial<ReturnType<PrefsStore['get']>>
      // 只落显式给出的字段——undefined 会让 normalizePrefs 把已学权重清成默认
      const patch = Object.fromEntries(Object.entries({
        topics: body.topics, keywords: body.keywords,
        bannedKeywords: body.bannedKeywords, sourceWeight: body.sourceWeight,
        proxyUrl: body.proxyUrl, autoTranslate: body.autoTranslate,
        showNavEntry: body.showNavEntry, loopGuard: body.loopGuard, backup: body.backup,
        devLog: body.devLog, notifyDesktop: body.notifyDesktop,
        digestOpts: body.digestOpts, subscribedTopics: body.subscribedTopics,
        fontSize: body.fontSize, llmConcurrency: body.llmConcurrency, wide: body.wide,
        contentBlocklist: body.contentBlocklist, stubLimits: body.stubLimits,
      }).filter(([, v]) => v !== undefined))
      deps.prefs.save(patch)
      // 名单变更后回扫存量：新加词条命中的短正文条目立刻隐藏（删词条不解隐——hidden 可能来自别的途径）
      if (body.contentBlocklist !== undefined) await deps.svc?.rescanStubContent?.()
      return sendJson(res, 200, { ok: true, prefs: deps.prefs.get() })
    }
    sendJson(res, 405, { ok: false, error: `unsupported ${method}` })
  }
}

/** /api/llm：GET 列 provider（?provider=p 时列其 model）；POST 设/清 UI 模型覆盖 */
function apiLlm(deps: ApiDeps) {
  return async (req: Req, res: Res) => {
    const method = String(req.method || 'GET').toUpperCase()
    const runtime = deps.getLlm?.()
    const ui = deps.prefs.get().llm
    const cfg = deps.configLlm
    const effective = ui?.provider && ui?.model ? 'ui' : (cfg?.provider && cfg?.model ? 'config' : 'auto')
    const current = effective === 'ui' ? ui! : effective === 'config' ? cfg! : { provider: '', model: '' }
    if (method === 'GET') {
      if (!runtime) return sendJson(res, 200, { ok: true, available: false, providers: [], models: [], current, effective })
      const u = new URL(req.url || '', 'http://x')
      const provider = u.searchParams.get('provider') || ''
      const providers = runtime.listProviders().map((p) => ({ id: p.id }))
      let models: string[] = []
      if (provider) {
        models = (await runtime.listModels(provider).catch(() => [])).map((m) => m.id)
      }
      return sendJson(res, 200, { ok: true, available: true, providers, models, current, effective })
    }
    if (method === 'POST') {
      const body = await readBody(req) as { provider?: string; model?: string; scope?: string }
      const provider = String(body.provider || '').trim()
      const model = String(body.model || '').trim()
      if (body.scope === 'translate') {
        if (provider && model) deps.prefs.save({ translateLlm: { provider, model } })
        else deps.prefs.save({ translateLlm: undefined })
        return sendJson(res, 200, { ok: true, translateLlm: deps.prefs.get().translateLlm })
      }
      if (provider && model) deps.prefs.save({ llm: { provider, model } })
      else deps.prefs.save({ llm: undefined }) // 空对 = 清除覆盖回自动
      return sendJson(res, 200, { ok: true, llm: deps.prefs.get().llm })
    }
    sendJson(res, 405, { ok: false, error: `unsupported ${method}` })
  }
}

async function serveStatic(res: Res, rel: string): Promise<void> {
  const webDir = join(fileURLToPath(new URL('.', import.meta.url)), 'web')
  const safe = rel.split('?')[0].replace(/^\/+|\.{2,}/g, '') || 'index.html'
  const file = join(webDir, safe)
  try {
    const body = await readFile(file)
    res.statusCode = 200
    res.setHeader('content-type', MIME[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream')
    res.end(body as unknown as string)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}

/** 注册阅读器全部路由；返回 disposer。MOUNT 于 ctx.inject(['webServer']) 内调用。 */
export function mountApi(ws: WebServerLike, deps: ApiDeps): () => void {
  const disposers: Array<() => void> = []
  const guard = (fn: (req: Req, res: Res) => void | Promise<void>) => (req: Req, res: Res): Promise<void> => {
    if (!sameSite(req)) { res.statusCode = 403; res.end('forbidden'); return Promise.resolve() }
    deps.onApiHit?.() // 任何请求都算页面活跃——空闲判定（integrity_check 避让）据此
    return Promise.resolve(fn(req, res)).catch((e) => sendJson(res, 500, { ok: false, error: String(e) }))
  }

  // 静态页（exact 匹配目录入口 + prefix 资源）
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/`, handler: guard((_q, r) => serveStatic(r, 'index.html')) }))
  disposers.push(ws.register({ kind: 'exact', path: BASE, handler: guard((_q, r) => serveStatic(r, 'index.html')) }))
  // 宿主 prefix 语义 = 精确命中 p 或 p/<x>；注册必须不带尾斜杠（否则要求双斜杠才中）
  disposers.push(ws.register({ kind: 'prefix', path: `${BASE}/web`, handler: guard((q, r) => serveStatic(r, (q.url || '').replace(`${BASE}/web/`, ''))) }))

  // JSON API
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/items`, handler: guard(apiItems(deps)) }))
  disposers.push(ws.register({ kind: 'prefix', path: `${BASE}/api/archive`, handler: guard(apiArchive(deps)) }))
  disposers.push(ws.register({ kind: 'prefix', path: `${BASE}/api/digest`, handler: guard((q, r) => apiDigest(deps)(q, r, ((q.url || '').split('/').pop() || '').split('?')[0] || zonedDayKey(new Date(), deps.timezone))) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/digest`, handler: guard((q, r) => apiDigest(deps)(q, r, zonedDayKey(new Date(), deps.timezone))) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/digest-stop`, handler: guard(async (q, r) => { if (q.method !== 'POST') { r.statusCode = 405; r.end(); return } sendJson(r, 200, { ok: true, result: await deps.svc.stopDigest?.() }) }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/feedback`, handler: guard(apiFeedback(deps)) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/sources`, handler: guard((q, r) => apiSources(deps)(q, r, '')) }))
  disposers.push(ws.register({ kind: 'prefix', path: `${BASE}/api/sources`, handler: guard((q, r) => apiSources(deps)(q, r, (q.url || '').replace(`${BASE}/api/sources`, '').replace(/^\//, ''))) }))
  // AI 专题：prefix 一条覆盖 /topics、/topics/preview、/topics/<id>/<act>
  disposers.push(ws.register({ kind: 'prefix', path: `${BASE}/api/topics`, handler: guard((q, r) => apiTopics(deps)(q, r, (q.url || '').replace(`${BASE}/api/topics`, '').replace(/^\//, '').split('?')[0])) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/topic-progress`, handler: guard(async (_q, r) => sendJson(r, 200, { ok: true, ...(await deps.svc.topicProgress?.() ?? { running: false, done: 0, total: 0 }) })) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/topic-stop`, handler: guard(async (q, r) => { if (q.method !== 'POST') { r.statusCode = 405; r.end(); return } const b = await readBody(q).catch(() => ({})) as { id?: unknown }; sendJson(r, 200, { ok: true, result: await deps.svc.stopTopic?.(typeof b.id === 'string' ? b.id : undefined) }) }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/opml`, handler: guard(apiOpml(deps)) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/opml-export`, handler: guard(async (_q, r) => {
    // guest webview 会话禁了 will-download——文件落盘是插件侧唯一可靠的"下载"
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { join, dirname } = await import('node:path')
    const dir = join(dirname(deps.store.path), 'exports')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `dsh-rss-news-daily-sources-${new Date().toISOString().slice(0, 10)}.opml`)
    await writeFile(file, await deps.svc.exportOpml(), 'utf8')
    sendJson(r, 200, { ok: true, path: file })
  }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/prefs`, handler: guard(apiPrefs(deps)) }))
  // 手动备份：rss-backup-<stamp>.zip（store.db 快照 + digests/ + prefs.json 单文件打包）
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/backup`, handler: guard(async (_q, r) => {
    const b = deps.prefs.get().backup
    if (!b?.dir) { sendJson(r, 400, { ok: false, error: '先在设置里填备份文件夹' }); return }
    try {
      const file = await runBackupZip(dirname(deps.store.path), deps.store as { snapshot?: (f: string) => void }, backupDirOf(b.dir), b.keep ?? 7)
      sendJson(r, 200, { ok: true, file })
    } catch (e) { sendJson(r, 500, { ok: false, error: String((e as Error)?.message || e) }) }
  }) }))
  // 恢复：先停在跑任务（抓取/翻译/评分/日报生成）→ 解 zip → 热替换库+设置+日报，免重启
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/restore`, handler: guard(async (q, r) => {
    if (q.method !== 'POST') { r.statusCode = 405; r.end(); return }
    const body = await readBody(q) as { path?: string }
    if (!body.path?.trim()) { sendJson(r, 400, { ok: false, error: 'path required' }); return }
    const dataDir = dirname(deps.store.path)
    try {
      // 1) 在飞任务全部叫停，等它们真正退出（写库的动作不能与换库并发）
      await Promise.all([
        deps.svc.cancelFetch?.().catch(() => undefined),
        deps.svc.stopDigest?.().catch(() => undefined),
        deps.svc.stopTopic?.().catch(() => undefined),
      ])
      const waitStop = async (prog?: () => Promise<{ running?: boolean; cancelled?: boolean }>) => {
        if (!prog) return true
        for (let i = 0; i < 100; i++) {
          const p = await prog().catch(() => ({ running: false }))
          if (!p?.running) return true
          await new Promise((s) => setTimeout(s, 300))
        }
        return false
      }
      const stopped = await Promise.all([
        waitStop(deps.svc.fetchProgress?.bind(deps.svc)),
        waitStop(deps.svc.digestProgress?.bind(deps.svc)),
        waitStop(deps.svc.topicProgress?.bind(deps.svc)),
      ])
      if (!stopped.every(Boolean)) { sendJson(r, 409, { ok: false, error: '任务停止超时，请稍后再试' }); return }
      // 2) 解包到 .restore-pending/（boot 兜底路径也走这里）
      const staged = await stageRestore(dataDir, body.path.trim())
      const pending = join(dataDir, '.restore-pending')
      const st = deps.store as { restoreFrom?: (f: string) => Promise<void> }
      if (st.restoreFrom && existsSync(join(pending, 'store.db'))) {
        // 3) 热恢复：库整体替换重载、prefs 重读、日报目录替换
        await st.restoreFrom(join(pending, 'store.db'))
        const pp = join(pending, 'prefs.json')
        if (existsSync(pp)) { await copyFile(pp, join(dataDir, 'prefs.json')); (deps.prefs as { load?: () => void }).load?.() }
        const pd = join(pending, 'digests')
        if (existsSync(pd)) {
          await rm(join(dataDir, 'digests'), { recursive: true, force: true })
          await cp(pd, join(dataDir, 'digests'), { recursive: true })
        }
        await rm(pending, { recursive: true, force: true })
        sendJson(r, 200, { ok: true, ...staged })
      } else {
        // 无热恢复能力的 store：留在 pending，重启生效
        sendJson(r, 200, { ok: true, ...staged, needsRestart: true })
      }
    } catch (e) { sendJson(r, 400, { ok: false, error: String((e as Error)?.message || e) }) }
  }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/loopguard`, handler: guard(async (_q, r) => {
    const nm = dirname(fileURLToPath(new URL('../', import.meta.url))) // 包根的上级 = node_modules/
    const installed = existsSync(join(nm, 'dsh-loop-recover', 'package.json'))
    let enabled = false
    if (installed) {
      try {
        const profPkg = JSON.parse(await readFile(join(nm, '..', 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
        enabled = (profPkg.dsh?.profile?.bundles ?? []).includes('dsh-loop-recover')
        const patch = await readFile(join(nm, '..', 'cordis.patch.yml'), 'utf8').catch(() => '')
        // 按条目块判断：disabled 必须落在 loop-recover 自己的块里（下一条目的 disabled 会误伤）
        const block = patch.split(/^- id:/m).find((b) => /^\s*loop-recover\b/.test(b))
        if (block && /disabled:\s*true/.test(block)) enabled = false
      } catch { /* 读不到 profile 则按未启用 */ }
    }
    sendJson(r, 200, { ok: true, installed, enabled, pref: deps.prefs.get().loopGuard ?? null, active: loopDetectStatus() === 'active' })
  }) }))
  // 系统目录选择：借宿主 directoryPicker 的 native 能力弹一次 OS 对话框；
  // browse 能力只有逐级浏览原语、无单次 pick，远程部署降级为手动输入
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/pick-dir`, handler: guard(async (q, r) => {
    if (q.method !== 'POST') { r.statusCode = 405; r.end(); return }
    const cap = deps.getDirectoryPicker?.()?.capability?.()
    if (cap?.kind !== 'native' || typeof cap.pick !== 'function') {
      sendJson(r, 200, { ok: true, supported: false, path: null })
      return
    }
    try {
      const path = await cap.pick(AbortSignal.timeout(300_000))
      sendJson(r, 200, { ok: true, supported: true, path })
    } catch (e) {
      sendJson(r, 200, { ok: true, supported: true, path: null, error: String((e as Error)?.message || e) })
    }
  }) }))
  // 开发日志：状态查询 + 系统文件管理器打开日志目录（路径固定为插件数据目录下的 devlog/，不接受外部输入）
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/devlog`, handler: guard(async (_q, r) => {
    const dir = deps.devlogDir
    const enabled = deps.prefs.get().devLog === true
    let files: Array<{ name: string; size: number; mtime: string }> = []
    if (dir && existsSync(dir)) {
      const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith('dev-') && n.endsWith('.jsonl')).sort().reverse().slice(0, 7)
      files = await Promise.all(names.map(async (name) => {
        const st = await stat(join(dir, name)).catch(() => null)
        return { name, size: st?.size ?? 0, mtime: st ? new Date(st.mtimeMs).toISOString() : '' }
      }))
    }
    sendJson(r, 200, { ok: true, enabled, dir: dir ?? null, files })
  }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/devlog/open`, handler: guard(async (q, r) => {
    if (q.method !== 'POST') { r.statusCode = 405; r.end(); return }
    const dir = deps.devlogDir
    if (!dir) return sendJson(r, 200, { ok: false, error: 'devlog dir not configured' })
    try {
      await mkdir(dir, { recursive: true })
      const p = platform()
      const [cmd, args] = p === 'darwin' ? ['open', [dir]]
        : p === 'win32' ? ['explorer.exe', [dir]]
        : ['xdg-open', [dir]]
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
      child.unref()
      child.once('error', (e) => sendJson(r, 200, { ok: false, error: String(e) }))
      child.once('spawn', () => sendJson(r, 200, { ok: true }))
    } catch (e) { sendJson(r, 200, { ok: false, error: String((e as Error)?.message || e) }) }
  }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/llm`, handler: guard(apiLlm(deps)) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/schedule`, handler: guard(async (q, r) => {
    const method = String(q.method || 'GET').toUpperCase()
    const ui = deps.prefs.get().schedule
    const def = deps.configSchedule ?? { digestTimes: [], fetchTimes: [] }
    if (method === 'GET') {
      return sendJson(r, 200, { ok: true, effective: ui ? 'ui' : 'config', schedule: ui ?? def })
    }
    if (method === 'POST') {
      const body = await readBody(q) as { digestTimes?: string[]; fetchTimes?: string[]; intervalMinutes?: number; onStartup?: boolean; clear?: boolean }
      if (body.clear) deps.prefs.save({ schedule: undefined })
      else {
        deps.prefs.save({ schedule: {
          digestTimes: Array.isArray(body.digestTimes) ? body.digestTimes : [],
          fetchTimes: Array.isArray(body.fetchTimes) ? body.fetchTimes : [],
          ...(typeof body.intervalMinutes === 'number' && body.intervalMinutes > 0 ? { intervalMinutes: body.intervalMinutes } : {}),
          ...(typeof body.onStartup === 'boolean' ? { onStartup: body.onStartup } : {}),
        } })
      }
      return sendJson(r, 200, { ok: true, schedule: deps.prefs.get().schedule ?? def })
    }
    sendJson(r, 405, { ok: false, error: `unsupported ${method}` })
  }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/tune`, handler: guard(async (q, r) => {
    const body = await readBody(q) as { text?: string }
    const res2 = parseTune(String(body.text || ''), deps.prefs.get())
    if (res2.ok && res2.patch) {
      deps.prefs.applyTune(String(body.text || ''), res2.actions.map((a) => `${a.kind}:${a.target}`), res2.patch)
    }
    sendJson(r, res2.ok ? 200 : 400, { ok: res2.ok, error: res2.error, actions: res2.actions.map((a) => `${a.kind}:${a.target}${a.factor ? `×${a.factor}` : ''}`), prefs: deps.prefs.get() })
  }) }))
  const postOnly = (q: Req): boolean => String(q.method || 'GET').toUpperCase() === 'POST'
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/fetch`, handler: guard(async (q, r) => {
    if (!postOnly(q)) return sendJson(r, 405, { ok: false, error: 'use POST' })
    const body = await readBody(q) as { force?: boolean; onlyFailed?: boolean; source?: string; category?: string }
    // fire-and-forget：autoTranslate 串行翻译远超 HTTP 超时,立即返回+前端轮询 /fetch-progress
    deps.svc.runFetch(!!body?.force, !!body?.onlyFailed, { source: body?.source, category: body?.category })
      .catch(() => { /* 错误经 progress/日志可见 */ })
    sendJson(r, 200, { ok: true, started: true })
  }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/digests/clear`, handler: guard(async (q, r) => {
    if (!postOnly(q)) return sendJson(r, 405, { ok: false, error: 'use POST' })
    const { readdir, unlink } = await import('node:fs/promises')
    let deleted = 0
    let files: string[]
    try {
      files = await readdir(deps.digestsDir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') files = []
      else throw e
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue // 只清日报/快报,index.json 等保留
      await unlink(join(deps.digestsDir, f))
      deleted += 1
    }
    sendJson(r, 200, { ok: true, deleted })
  }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/items/clear`, handler: guard(async (q, r) => {
    if (!postOnly(q)) return sendJson(r, 405, { ok: false, error: 'use POST' })
    const deleted = deps.store.clearItems()
    deps.store.meta.lastFetchAdded = 0 // 上轮新增计数同步归零
    await deps.store.save()
    sendJson(r, 200, { ok: true, deleted })
  }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/fetch-progress`, handler: guard(async (_q, r) => sendJson(r, 200, { ok: true, ...(await deps.svc.fetchProgress?.() ?? { running: false, done: 0, total: 0 }) })) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/digest-progress`, handler: guard(async (_q, r) => sendJson(r, 200, { ok: true, ...(await deps.svc.digestProgress?.() ?? { running: false, done: 0, total: 0 }) })) }))
  // 全局任务队列：悬停提示渲染全部在跑/排队任务；task-cancel 按 id 取消（waiting 撤队 / running abort）
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/tasks`, handler: guard(async (_q, r) => sendJson(r, 200, { ok: true, ...(await deps.svc.taskList?.() ?? { limit: 1, running: [], waiting: [] }) })) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/task-cancel`, handler: guard(async (q, r) => {
    if (!postOnly(q)) return sendJson(r, 405, { ok: false, error: 'use POST' })
    const body = await readBody(q) as { id?: string }
    if (!body?.id) return sendJson(r, 400, { ok: false, error: 'missing id' })
    sendJson(r, 200, { ok: true, result: await deps.svc.cancelTask?.(body.id) ?? { ok: false } })
  }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/fetch-test`, handler: guard(async (q, r) => {
    const u = new URL(q.url || '/', 'http://x').searchParams
    const url = u.get('url') || ''
    if (!/^https?:\/\//.test(url)) { sendJson(r, 400, { ok: false, error: '需要 http(s) URL' }); return }
    const pv = u.get('proxy')
    const res = await deps.svc.testFetch!(url, pv === '1' || pv === 'true' ? true : undefined)
    sendJson(r, 200, { ok: !('error' in res) || res.error === undefined, ...res })
  }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/fetch-cancel`, handler: guard(async (q, r) => { if (q.method !== 'POST') { r.statusCode = 405; r.end(); return } sendJson(r, 200, { ok: true, result: await deps.svc.cancelFetch?.() }) }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/digest-run`, handler: guard(async (q, r) => {
    if (!postOnly(q)) return sendJson(r, 405, { ok: false, error: 'use POST' })
    const body = await readBody(q) as { force?: boolean; day?: string }
    const day = /^\d{4}-\d{2}-\d{2}$/.test(body?.day || '') ? body!.day : undefined
    // fire-and-forget：大 digestItems 下 LLM 全链路远超 HTTP 请求超时，
    // 改为立即返回 + 前端轮询 /digest-progress 收尾
    deps.runDigest(!!body?.force, day).catch(() => { /* 错误经 progress/degraded 可见 */ })
    sendJson(r, 200, { ok: true, started: true })
  }) }))
  // P7 导出/导入：NDJSON 流式 bundle + .db 快照
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/export`, handler: guard(async (q, r) => {
    const st = deps.store as { exportNdjson?: (f: string, d: string, s?: string) => Promise<number>; snapshot?: (f: string) => void }
    if (!st.exportNdjson) return sendJson(r, 400, { ok: false, error: 'sqlite backend required' })
    const u = new URL(q.url || '', 'http://x')
    const kind = u.searchParams.get('kind') || 'ndjson' // ndjson | db
    const scope = (u.searchParams.get('scope') || 'all') as 'all' | 'items' | 'digests'
    const dir = join(dirname(deps.store.path), 'exports')
    const file = join(dir, kind === 'db' ? `store-${Date.now()}.db` : `rss-export-${Date.now()}.ndjson`)
    if (kind === 'db') { st.snapshot!(file); return sendJson(r, 200, { ok: true, file }) }
    const n = await st.exportNdjson(file, deps.digestsDir, scope)
    sendJson(r, 200, { ok: true, file, items: n })
  }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/import`, handler: guard(async (q, r) => {
    if (q.method !== 'POST') { r.statusCode = 405; r.end(); return }
    const st = deps.store as { importNdjson?: (f: string, d: string) => Promise<{ items: number; sources: number; digests: number }> }
    if (!st.importNdjson) return sendJson(r, 400, { ok: false, error: 'sqlite backend required' })
    const body = await readBody(q) as { path?: string }
    if (!body.path) return sendJson(r, 400, { ok: false, error: 'path required' })
    const counts = await st.importNdjson(body.path, deps.digestsDir)
    sendJson(r, 200, { ok: true, ...counts })
  }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/status`, handler: guard((q, r) => {
    if (new URL(q.url || '', 'http://x').searchParams.get('act') === '1') deps.onGesture?.()
    sendJson(r, 200, { ok: true, ...deps.svc.status() })
  }) }))

  return () => disposers.forEach((d) => d())
}
