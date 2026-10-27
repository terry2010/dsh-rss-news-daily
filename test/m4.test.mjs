import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mkStore = async () => {
  const { Store } = await import('../lib/core/store.js')
  const st = new Store({ path: join(mkdtempSync(join(tmpdir(), 'rnd-m4-')), 's.json') })
  await st.load()
  return st
}
const mkItem = (id, over = {}) => ({
  id, sourceId: 's1', title: `T-${id}`, link: `https://x/${id}`, summary: `sum ${id}`, content: '',
  publishedAt: '2026-01-01', fetchedAt: new Date().toISOString(), hash: `h${id}`, digestedDay: '',
  topic: 'AI', score: 0, reasons: [], state: { read: false, hidden: false, liked: 0 }, ...over,
})

// ---- parseTune ----

test('parseTune: 多推/少推/屏蔽/重置 句式 → 确定性 patch', async () => {
  const { parseTune } = await import('../lib/core/tune.js')
  const prefs = { topics: {}, keywords: {}, bannedKeywords: [], sourceWeight: {} }

  const up = parseTune('多推 AI Agent', prefs)
  assert.equal(up.ok, true)
  assert.ok(up.patch.topics['AI Agent'] >= 1.3 || up.patch.keywords['AI Agent'] >= 1.5)

  const down = parseTune('少推币圈', prefs)
  assert.equal(down.ok, true)
  const target = down.patch.topics['币圈'] ?? down.patch.keywords['币圈']
  assert.ok(target < 1, `expected down-weight, got ${target}`)

  const ban = parseTune('屏蔽裁员', prefs)
  assert.deepEqual(ban.patch.bannedKeywords, ['裁员'])

  const reset = parseTune('重置', { ...prefs, topics: { AI: 2 }, bannedKeywords: ['x'] })
  assert.deepEqual(reset.patch, { topics: {}, keywords: {}, bannedKeywords: [], sourceWeight: {} })

  const unban = parseTune('取消屏蔽裁员', { ...prefs, bannedKeywords: ['裁员'] })
  assert.deepEqual(unban.patch.bannedKeywords, [])
})

test('parseTune: 叠加权重 clamp 到 [0.1,3]，空输入报错', async () => {
  const { parseTune } = await import('../lib/core/tune.js')
  let prefs = { topics: { AI: 2.5 }, keywords: {}, bannedKeywords: [], sourceWeight: {} }
  const r = parseTune('多推 AI', prefs)
  assert.equal(r.patch.topics.AI, 3, 'clamp at 3')
  const r2 = parseTune('', prefs)
  assert.equal(r2.ok, false)
})

// ---- api handlers ----

const mkRes = () => {
  const r = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b ?? '' } }
  return r
}
const mkReq = (method, url, body) => ({
  method, url, headers: {},
  on(ev, cb) { if (ev === 'end') setImmediate(cb); if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body))) },
})

const mkDeps = async () => {
  const store = await mkStore()
  store.addItems([mkItem('a'), mkItem('b', { state: { read: true, hidden: false, liked: 0 } }), mkItem('c', { state: { read: false, hidden: true, liked: 0 } })])
  const { PrefsStore } = await import('../lib/core/prefs.js')
  const prefs = new PrefsStore(join(mkdtempSync(join(tmpdir(), 'rnd-p4-')), 'p.json'))
  const svc = {
    listSources: () => [], addSource: async () => ({}), setEnabled: async () => {},
    removeSource: async () => true, importOpml: async () => ({ added: 1, duplicated: 0, skipped: 0 }),
    exportOpml: async () => '<opml/>',
    runFetch: async () => ({ totalAdded: 3, errors: 0 }),
    status: () => ({ sources: 5, enabled: 4, items: store.items.length, lastFetchAt: 'x', lastDigestDay: 'y', failures: [] }),
  }
  return { store, prefs, svc, configSources: [], timezone: '', readerPageSize: 50, runDigest: async () => {} }
}

const findHandler = (regs, path) => regs.find((r) => r.path === path)?.handler

test('api: mountApi 注册全部路由；/api/items 过滤 + /api/feedback 持久化', async () => {
  const { mountApi } = await import('../lib/api.js')
  const deps = await mkDeps()
  const regs = []
  const ws = { register: (o) => { regs.push(o); return () => {} } }
  mountApi(ws, deps)

  const items = findHandler(regs, '/dsh-rss-news-daily/api/items')
  let res = mkRes()
  await items(mkReq('GET', '/dsh-rss-news-daily/api/items?unread=1'), res)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, true)
  assert.ok(parsed.items.every((i) => !i.state.hidden), 'hidden items must be filtered')

  res = mkRes()
  await items(mkReq('GET', '/dsh-rss-news-daily/api/items?category=AI'), res)
  assert.ok(JSON.parse(res.body).items.length >= 1)

  const fb = findHandler(regs, '/dsh-rss-news-daily/api/feedback')
  res = mkRes()
  await fb(mkReq('POST', '/dsh-rss-news-daily/api/feedback', { id: 'a', action: 'like' }), res)
  assert.equal(JSON.parse(res.body).state.liked, 1)
  assert.equal(deps.store.items.find((i) => i.id === 'a').state.liked, 1, 'feedback must persist to store')

  res = mkRes()
  await fb(mkReq('POST', '/dsh-rss-news-daily/api/feedback', { id: 'a', action: 'bogus' }), res)
  assert.equal(res.statusCode, 400)
})

test('api: /api/tune 应用 parseTune 并落 prefs', async () => {
  const { mountApi } = await import('../lib/api.js')
  const deps = await mkDeps()
  const regs = []
  mountApi({ register: (o) => { regs.push(o); return () => {} } }, deps)
  const tune = findHandler(regs, '/dsh-rss-news-daily/api/tune')
  const res = mkRes()
  await tune(mkReq('POST', '/dsh-rss-news-daily/api/tune', { text: '多推 AI、屏蔽裁员' }), res)
  const out = JSON.parse(res.body)
  assert.equal(out.ok, true)
  assert.ok(deps.prefs.get().bannedKeywords.includes('裁员'))
  assert.ok(deps.prefs.get().tuningHistory.length >= 1)
})

test('api: /api/sources POST 走 svc.addSource 校验；PATCH/DELETE 生效', async () => {
  const { mountApi } = await import('../lib/api.js')
  const deps = await mkDeps()
  let added = null, toggled = null, removed = null
  deps.svc.addSource = async (o) => { added = o; return { id: 'x', url: o.url, title: 'T' } }
  deps.svc.setEnabled = async (id, en) => { toggled = { id, en } }
  deps.svc.removeSource = async (id) => { removed = id; return true }
  const regs = []
  mountApi({ register: (o) => { regs.push(o); return () => {} } }, deps)
  const srcs = findHandler(regs, '/dsh-rss-news-daily/api/sources')
  const srcsSub = findHandler(regs, '/dsh-rss-news-daily/api/sources/')
  let res = mkRes()
  await srcs(mkReq('POST', '/dsh-rss-news-daily/api/sources', { url: 'https://n/feed' }), res)
  assert.equal(added.url, 'https://n/feed')
  res = mkRes()
  await srcsSub(mkReq('PATCH', '/dsh-rss-news-daily/api/sources/https%3A%2F%2Fx%2Ff', { enabled: false }), res)
  assert.deepEqual(toggled, { id: 'https://x/f', en: false })
  res = mkRes()
  await srcsSub(mkReq('DELETE', '/dsh-rss-news-daily/api/sources/https%3A%2F%2Fx%2Ff'), res)
  assert.equal(removed, 'https://x/f')
})

test('api: /api/opml GET 导出 + POST 导入走 svc；/api/prefs GET/POST；/api/status', async () => {
  const { mountApi } = await import('../lib/api.js')
  const deps = await mkDeps()
  const regs = []
  mountApi({ register: (o) => { regs.push(o); return () => {} } }, deps)
  let res = mkRes()
  await findHandler(regs, '/dsh-rss-news-daily/api/opml')(mkReq('GET', '/dsh-rss-news-daily/api/opml'), res)
  assert.equal(res.body, '<opml/>')
  res = mkRes()
  await findHandler(regs, '/dsh-rss-news-daily/api/opml')(mkReq('POST', '/dsh-rss-news-daily/api/opml', { opml: '<x/>' }), res)
  assert.equal(JSON.parse(res.body).added, 1)
  res = mkRes()
  await findHandler(regs, '/dsh-rss-news-daily/api/prefs')(mkReq('GET', '/dsh-rss-news-daily/api/prefs'), res)
  assert.equal(JSON.parse(res.body).ok, true)
  res = mkRes()
  await findHandler(regs, '/dsh-rss-news-daily/api/prefs')(mkReq('POST', '/dsh-rss-news-daily/api/prefs', { bannedKeywords: ['x'] }), res)
  assert.deepEqual(deps.prefs.get().bannedKeywords, ['x'])
  res = mkRes()
  await findHandler(regs, '/dsh-rss-news-daily/api/status')(mkReq('GET', '/dsh-rss-news-daily/api/status'), res)
  assert.equal(JSON.parse(res.body).items, 3)
})

test('api: /api/items 分页与 day 过滤', async () => {
  const { mountApi } = await import('../lib/api.js')
  const deps = await mkDeps()
  deps.readerPageSize = 2
  deps.store.items[0].fetchedAt = '2020-01-01T00:00:00Z'
  const regs = []
  mountApi({ register: (o) => { regs.push(o); return () => {} } }, deps)
  const items = findHandler(regs, '/dsh-rss-news-daily/api/items')
  let res = mkRes()
  await items(mkReq('GET', '/dsh-rss-news-daily/api/items'), res)
  const p1 = JSON.parse(res.body)
  assert.equal(p1.items.length, 2)
  assert.equal(p1.total, 2, 'hidden 剔除后总数')
  res = mkRes()
  await items(mkReq('GET', `/dsh-rss-news-daily/api/items?day=${new Date().toISOString().slice(0, 10)}`), res)
  assert.equal(JSON.parse(res.body).items.length, 1, 'day 过滤只留今天的')
})

test('api: serveStatic 路径消毒——../ 与不存在返回 404', async () => {
  const { mountApi } = await import('../lib/api.js')
  const deps = await mkDeps()
  const regs = []
  mountApi({ register: (o) => { regs.push(o); return () => {} } }, deps)
  const st = findHandler(regs, '/dsh-rss-news-daily/web/')
  let res = mkRes()
  await st(mkReq('GET', '/dsh-rss-news-daily/web/../index.ts'), res)
  assert.equal(res.statusCode, 404)
  res = mkRes()
  await st(mkReq('GET', '/dsh-rss-news-daily/web/nope.js'), res)
  assert.equal(res.statusCode, 404)
})

test('api: cross-site 请求被 403', async () => {
  const { mountApi } = await import('../lib/api.js')
  const deps = await mkDeps()
  const regs = []
  mountApi({ register: (o) => { regs.push(o); return () => {} } }, deps)
  const items = findHandler(regs, '/dsh-rss-news-daily/api/items')
  const res = mkRes()
  const req = mkReq('GET', '/dsh-rss-news-daily/api/items')
  req.headers['sec-fetch-site'] = 'cross-site'
  await items(req, res)
  assert.equal(res.statusCode, 403)
})
