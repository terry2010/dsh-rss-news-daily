/**
 * webServer 路由：静态阅读器 /dsh-rss-news-daily/ + /api/* JSON 端点。
 * 全部 handler 是原生 req/res；sendJson 统一响应。同源检查拦 cross-site。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { zonedDayBounds } from './core/time.js'

import type { StoreLike } from './core/store.js'
import type { PrefsStore } from './core/prefs.js'
import type { NewsService } from './tools.js'
import { effectiveSources } from './service.js'
import { zonedDayKey } from './core/time.js'
import { parseTune, learnFromFeedback } from './core/tune.js'

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
  /** config 层的 llm 路由对（用于 effective 判定展示） */
  configLlm?: { provider: string; model: string }
  /** config 层的调度默认（UI 覆盖的回落） */
  configSchedule?: { digestTimes: string[]; fetchTimes: string[] }
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
        sources: deps.svc.listSources()
          .sort((a, b) => (a.builtin === b.builtin ? (a.builtin ? 0 : (b.addedAt || '').localeCompare(a.addedAt || '')) : a.builtin ? 1 : -1)) // 用户源在最上且按添加时间倒序
          .map((s) => ({
          id: s.id, url: s.url, title: s.title, category: s.category, tier: s.tier, lang: s.lang,
          enabled: s.enabled, builtin: s.builtin, summarize: s.summarize, proxy: s.proxy, cooldownHours: s.cooldownHours, health: s.health,
        })),
      })
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
        digestOpts: body.digestOpts, subscribedTopics: body.subscribedTopics,
      }).filter(([, v]) => v !== undefined))
      deps.prefs.save(patch)
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
  const safe = rel.replace(/^\/+|\.{2,}/g, '') || 'index.html'
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
    return Promise.resolve(fn(req, res)).catch((e) => sendJson(res, 500, { ok: false, error: String(e) }))
  }

  // 静态页（exact 匹配目录入口 + prefix 资源）
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/`, handler: guard((_q, r) => serveStatic(r, 'index.html')) }))
  disposers.push(ws.register({ kind: 'exact', path: BASE, handler: guard((_q, r) => serveStatic(r, 'index.html')) }))
  // 宿主 prefix 语义 = 精确命中 p 或 p/<x>；注册必须不带尾斜杠（否则要求双斜杠才中）
  disposers.push(ws.register({ kind: 'prefix', path: `${BASE}/web`, handler: guard((q, r) => serveStatic(r, (q.url || '').replace(`${BASE}/web/`, ''))) }))

  // JSON API
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/items`, handler: guard(apiItems(deps)) }))
  disposers.push(ws.register({ kind: 'prefix', path: `${BASE}/api/digest`, handler: guard((q, r) => apiDigest(deps)(q, r, ((q.url || '').split('/').pop() || '').split('?')[0] || zonedDayKey(new Date(), deps.timezone))) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/digest`, handler: guard((q, r) => apiDigest(deps)(q, r, zonedDayKey(new Date(), deps.timezone))) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/digest-stop`, handler: guard(async (q, r) => { if (q.method !== 'POST') { r.statusCode = 405; r.end(); return } sendJson(r, 200, { ok: true, result: await deps.svc.stopDigest?.() }) }) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/feedback`, handler: guard(apiFeedback(deps)) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/sources`, handler: guard((q, r) => apiSources(deps)(q, r, '')) }))
  disposers.push(ws.register({ kind: 'prefix', path: `${BASE}/api/sources`, handler: guard((q, r) => apiSources(deps)(q, r, (q.url || '').replace(`${BASE}/api/sources`, '').replace(/^\//, ''))) }))
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
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/fetch-progress`, handler: guard(async (_q, r) => sendJson(r, 200, { ok: true, ...(await deps.svc.fetchProgress?.() ?? { running: false, done: 0, total: 0 }) })) }))
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/digest-progress`, handler: guard(async (_q, r) => sendJson(r, 200, { ok: true, ...(await deps.svc.digestProgress?.() ?? { running: false, done: 0, total: 0 }) })) }))
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
  disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/status`, handler: guard((_q, r) => sendJson(r, 200, { ok: true, ...deps.svc.status() })) }))

  return () => disposers.forEach((d) => d())
}
