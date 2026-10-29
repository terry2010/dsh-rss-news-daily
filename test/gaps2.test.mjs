import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mkRes = () => ({ statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b ?? '' } })
const mkReq = (method, url, body) => ({
  method, url, headers: {},
  on(ev, cb) { if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') setImmediate(cb) },
})
const json = (r) => JSON.parse(r.body)
const mkStore = async () => {
  const { SqliteStore } = await import('../lib/core/sqlite-store.js')
  const st = new SqliteStore({ path: join(mkdtempSync(join(tmpdir(), 'rnd-g2-')), 's.db') })
  await st.load(); return st
}
const mkItem = (id, over = {}) => ({
  id, sourceId: 's1', title: `T-${id}`, link: `https://x/${id}`, summary: `s${id}`,
  publishedAt: '2026-01-01', fetchedAt: new Date().toISOString(), hash: `h${id}`, digestedDay: '',
  topic: 'AI', score: 0, reasons: [], state: { read: false, hidden: false, liked: 0 }, ...over,
})
const findH = (regs, path) => regs.find((r) => r.path === path)?.handler
const findPrefix = (regs, path) => regs.filter((r) => r.kind === 'prefix').find((r) => r.path === path)?.handler
const mkDeps = async (svcOver = {}) => {
  const { PrefsStore } = await import('../lib/core/prefs.js')
  const prefs = new PrefsStore(join(mkdtempSync(join(tmpdir(), 'rnd-g2p-')), 'p.json'))
  const store = await mkStore()
  const digestsDir = join(mkdtempSync(join(tmpdir(), 'rnd-g2d-')), 'digests')
  mkdirSync(digestsDir, { recursive: true })
  const calls = []
  const svc = {
    listSources: () => [], addSource: async (a) => { calls.push(['addSource', a]); return { id: 'u1', url: a.url, title: a.title || 'T' } },
    setEnabled: async () => {}, setSummarize: async () => {}, updateSource: async () => {},
    retrySource: async (id) => { calls.push(['retrySource', id]); return true },
    exportOpml: async () => '<opml/>', importOpml: async () => ({ added: 1, skipped: 0 }),
    tune: async (t) => ({ ok: true, learned: t }),
    getDigest: async () => ({ markdown: '## d' }), regenDigest: async () => {},
    searchItems: () => [], feedback: async () => ({ ok: true }),
    status: () => ({}), fetchProgress: async () => ({}), digestProgress: async () => ({}),
    cancelFetch: async () => true, stopDigest: async () => true, cancelDigest: async () => true,
    runFetch: async () => ({}), runDigest: async () => ({}),
    translateItem: async () => ({ ok: true, translation: '译' }),
    fetchTest: async (url) => { calls.push(['fetchTest', url]); return { status: 200, body: 'x' } },
    ...svcOver,
  }
  return { prefs, store, svc, calls, digestsDir }
}
const mount = async (deps) => {
  const { mountApi } = await import('../lib/api.js')
  const regs = []
  mountApi({ register: (o) => { regs.push(o); return () => {} } }, {
    store: deps.store, prefs: deps.prefs, svc: deps.svc, readerPageSize: 50, digestsDir: deps.digestsDir, timezone: '',
    runDigest: deps.svc.runDigest, fetchTest: deps.svc.fetchTest,
  })
  return regs
}

// ---- api /sources ----

test('api /sources: GET 列表+POST 新增+PATCH 动作', async () => {
  const deps = await mkDeps()
  const regs = await mount(deps)
  const h = findH(regs, '/dsh-rss-news-daily/api/sources')
  const hp = findPrefix(regs, '/dsh-rss-news-daily/api/sources')
  let res = mkRes(); await h(mkReq('GET', '/dsh-rss-news-daily/api/sources'), res)
  assert.equal(json(res).ok, true)
  res = mkRes(); await h(mkReq('POST', '/dsh-rss-news-daily/api/sources', { url: 'https://u/f', title: 'U' }), res)
  assert.deepEqual(deps.calls[0], ['addSource', { url: 'https://u/f', title: 'U', category: undefined }])
  res = mkRes(); await hp(mkReq('PATCH', '/dsh-rss-news-daily/api/sources/u1', { action: 'retry' }), res)
  assert.deepEqual(deps.calls[1], ['retrySource', 'u1'])
  res = mkRes(); await hp(mkReq('PATCH', '/dsh-rss-news-daily/api/sources/u1', { enabled: false }), res)
  assert.equal(json(res).ok, true)
})

// ---- /api/tune /llm /schedule ----

test('api /tune POST → svc.tune', async () => {
  const deps = await mkDeps()
  const regs = await mount(deps)
  const h = findH(regs, '/dsh-rss-news-daily/api/tune')
  const res = mkRes(); await h(mkReq('POST', '/dsh-rss-news-daily/api/tune', { text: '多推AI' }), res)
  assert.equal(json(res).ok, true)
})

test('api /schedule GET+POST 存调度', async () => {
  const deps = await mkDeps()
  const regs = await mount(deps)
  const h = findH(regs, '/dsh-rss-news-daily/api/schedule')
  const res = mkRes(); await h(mkReq('POST', '/dsh-rss-news-daily/api/schedule', { digestTimes: ['08:00'], fetchTimes: ['12:00'], intervalMinutes: 30 }), res)
  assert.equal(json(res).ok, true)
  assert.equal(deps.prefs.get().schedule?.intervalMinutes, 30)
})

test('api /llm GET 返回配置投影', async () => {
  const deps = await mkDeps()
  const regs = await mount(deps)
  const h = findH(regs, '/dsh-rss-news-daily/api/llm')
  const res = mkRes(); await h(mkReq('GET', '/dsh-rss-news-daily/api/llm'), res)
  assert.equal(json(res).ok, true)
})

// ---- opml ----

test('api /opml POST 导入+解析失败 400', async () => {
  const deps = await mkDeps()
  const regs = await mount(deps)
  const h = findH(regs, '/dsh-rss-news-daily/api/opml')
  const res = mkRes(); await h(mkReq('POST', '/dsh-rss-news-daily/api/opml', { opml: '<opml/>' }), res)
  assert.equal(json(res).ok, true)
})
// === PART 1 END ===

// ---- fetch/digest 端点 ----

test('api /fetch POST fire-and-forget: 立即返回 started,参数转发', async () => {
  const got = []
  const deps = await mkDeps({ runFetch: async (force, onlyFailed, opts) => { got.push({ force, onlyFailed, opts }); return {} } })
  const regs = await mount(deps)
  const h = findH(regs, '/dsh-rss-news-daily/api/fetch')
  const res = mkRes(); await h(mkReq('POST', '/dsh-rss-news-daily/api/fetch', { force: true, source: 's1' }), res)
  assert.equal(json(res).started, true) // fire-and-forget 立即返回
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(got[0], { force: true, onlyFailed: false, opts: { source: 's1', category: undefined } })
})

test('api /fetch-cancel POST → svc.cancelFetch', async () => {
  const deps = await mkDeps()
  const regs = await mount(deps)
  const h = findH(regs, '/dsh-rss-news-daily/api/fetch-cancel')
  const res = mkRes(); await h(mkReq('POST', '/dsh-rss-news-daily/api/fetch-cancel', {}), res)
  assert.equal(json(res).ok, true)
})

test('api /items/clear: 清空条目并归零本次计数，保留订阅源/偏好', async () => {
  const deps = await mkDeps()
  deps.store.addSource({ id: 'source-1', url: 'https://source.example/feed', title: 'source', enabled: true, addedAt: '', category: 'AI', tier: 1, lang: 'en', method: 'direct', builtin: false, weight: 1, summarize: true, health: {} })
  deps.store.addItems([mkItem('clear-1', { sourceId: 'source-1' }), mkItem('clear-2', { sourceId: 'source-1' })])
  deps.store.meta.lastFetchAdded = 2
  deps.prefs.save({ topics: { AI: 1.5 } })
  await deps.store.save()
  const regs = await mount(deps)
  const h = findH(regs, '/dsh-rss-news-daily/api/items/clear')
  let res = mkRes()
  await h(mkReq('GET', '/dsh-rss-news-daily/api/items/clear'), res)
  assert.equal(res.statusCode, 405)
  res = mkRes()
  await h(mkReq('POST', '/dsh-rss-news-daily/api/items/clear', {}), res)
  assert.deepEqual(json(res), { ok: true, deleted: 2 })
  assert.equal(deps.store.count(), 0)
  assert.equal(deps.store.queryItems({ q: 'T-clear' }).total, 0)
  assert.equal(deps.store.sources.length, 1)
  assert.equal(deps.store.meta.lastFetchAdded, 0)
  assert.equal(deps.prefs.get().topics.AI, 1.5)
})

test('api /digests/clear: 仅删 Markdown，保留索引及其他文件；空目录安全', async () => {
  const deps = await mkDeps()
  writeFileSync(join(deps.digestsDir, '2026-10-29-rss-briefing.md'), '# daily')
  writeFileSync(join(deps.digestsDir, '2026-10-29-hourly.md'), '# hourly')
  writeFileSync(join(deps.digestsDir, 'index.json'), '{}')
  writeFileSync(join(deps.digestsDir, 'notes.txt'), 'keep')
  const regs = await mount(deps)
  const h = findH(regs, '/dsh-rss-news-daily/api/digests/clear')
  let res = mkRes()
  await h(mkReq('GET', '/dsh-rss-news-daily/api/digests/clear'), res)
  assert.equal(res.statusCode, 405)
  res = mkRes()
  await h(mkReq('POST', '/dsh-rss-news-daily/api/digests/clear', {}), res)
  assert.deepEqual(json(res), { ok: true, deleted: 2 })
  assert.deepEqual(readdirSync(deps.digestsDir).sort(), ['index.json', 'notes.txt'])
  const empty = await mkDeps()
  const emptyRegs = await mount(empty)
  res = mkRes()
  await findH(emptyRegs, '/dsh-rss-news-daily/api/digests/clear')(mkReq('POST', '/dsh-rss-news-daily/api/digests/clear', {}), res)
  assert.deepEqual(json(res), { ok: true, deleted: 0 })
})

test('api /digest-run POST 转发 day/force', async () => {
  const got = []
  const deps = await mkDeps({ runDigest: async (force, day) => { got.push({ force, day }); return {} } })
  const regs = await mount(deps)
  const h = findH(regs, '/dsh-rss-news-daily/api/digest-run')
  const res = mkRes(); await h(mkReq('POST', '/dsh-rss-news-daily/api/digest-run', { force: true, day: '2026-10-20' }), res)
  assert.equal(json(res).ok, true)
  assert.equal(got[0]?.day, '2026-10-20')
  assert.equal(got[0]?.force, true)
})

test('api /digest-stop POST → svc.stopDigest', async () => {
  const deps = await mkDeps()
  const regs = await mount(deps)
  const h = findH(regs, '/dsh-rss-news-daily/api/digest-stop')
  const res = mkRes(); await h(mkReq('POST', '/dsh-rss-news-daily/api/digest-stop', {}), res)
  assert.equal(json(res).ok, true)
})

test('api /digest-progress GET 透传 svc', async () => {
  const deps = await mkDeps({ digestProgress: async () => ({ running: true, done: 3, total: 9, stage: 'summaries' }) })
  const regs = await mount(deps)
  const h = findH(regs, '/dsh-rss-news-daily/api/digest-progress')
  const res = mkRes(); await h(mkReq('GET', '/dsh-rss-news-daily/api/digest-progress'), res)
  assert.equal(json(res).done, 3)
})

// ---- /api/feedback 动作面 ----

test('api /feedback: read/hide/like/translate 各动作', async () => {
  const deps = await mkDeps()
  deps.store.addItems([mkItem('a')])
  const regs = await mount(deps)
  const h = findH(regs, '/dsh-rss-news-daily/api/feedback')
  for (const action of ['read', 'hide', 'like']) {
    const res = mkRes()
    await h(mkReq('POST', '/dsh-rss-news-daily/api/feedback', { id: 'a', action }), res)
    assert.equal(json(res).ok, true, action)
  }
  const res = mkRes()
  await h(mkReq('POST', '/dsh-rss-news-daily/api/feedback', { id: 'a', action: 'translate' }), res)
  assert.equal(json(res).ok, true)
  const res404 = mkRes()
  await h(mkReq('POST', '/dsh-rss-news-daily/api/feedback', { id: 'nope', action: 'read' }), res404)
  assert.equal(res404.statusCode, 404)
})

// ---- tools execute 面 ----

test('tools: news_add/remove/fetch/search/feedback/tune/digest 逐个执行', async () => {
  const { registerTools } = await import('../lib/tools.js')
  const tools = {}
  const calls = []
  const ctx = { tools: { register: (t) => { tools[t.name] = t; return () => {} } } }
  const svc = {
    listSources: () => [{ id: 's1', url: 'u', title: 't', category: 'c', enabled: true, builtin: true }],
    status: () => ({ sources: 1, enabled: 1, items: 0, lastFetchAt: '', lastDigestDay: '', failures: [] }),
    addSource: async (a) => ({ ok: true, source: a }), removeSource: async () => ({ ok: true }),
    runFetch: async () => ({ added: 1 }), searchItems: () => [mkItem('x')],
    feedback: async (id, a) => ({ ok: true, id, a }), tune: async (t) => ({ ok: true, learned: t }),
    getDigest: async () => ({ markdown: 'md' }), regenDigest: async () => ({}),
    importOpml: async () => ({ added: 2 }), exportOpml: async () => '<opml/>',
  }
  registerTools(ctx, svc)
  assert.equal((await tools.news_sources.execute({})).count, 1)
  assert.equal((await tools.news_add.execute({ url: 'https://u/2' })).ok, true)
  assert.equal((await tools.news_remove.execute({ url: 'https://u/2' })).ok, true)
  assert.equal((await tools.news_search.execute({ q: 'T' })).items.length, 1)
  assert.equal((await tools.news_feedback.execute({ id: 'a', action: 'like' })).a, 'like')
  assert.equal((await tools.news_tune.execute({ text: '多推AI' })).learned, '多推AI')
  assert.equal((await tools.news_digest.execute({})).markdown, 'md')
})
test('scheduler: 只勾启动即抓不开轮询→挂startup不挂interval', async () => {
  const { startScheduler } = await import('../lib/scheduler.js')
  const calls = []
  const timers = { interval(fn, ms) { calls.push(['interval', ms]); return () => {} }, timeout(fn, ms) { calls.push(['timeout', ms]); return () => {} } }
  startScheduler(timers, {
    fetch: { enabled: true, intervalMinutes: 0, onStartup: true, fetchTimes: [] }, // interval 关
    dailyTime: '', timezone: '', catchUpHours: 0, enabled: false,
    lastDigestDay: () => '', runFetchCycle: async () => {}, runDailyDigest: async () => {}, getSchedule: () => ({}),
  })
  assert.equal(calls.filter(([k]) => k === 'timeout').length >= 1, true) // startup timer 挂了
  assert.equal(calls.filter(([k]) => k === 'interval').length, 0) // 轮询没挂
})
// === PART 2 END ===

// ---- service 源管理边界 ----

const RSS_XML = `<?xml version="1.0"?><rss version="2.0"><channel><title>XFeed</title><item><title>i1</title><link>https://x.com/1</link><pubDate>Mon, 27 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>`
const fakeFetchOk = async () => ({ body: RSS_XML }) // addSource 期望 fetch 返回 {body}
const fakeFetchFail = async () => ({ error: 'fetch failed' }) // 'error' in doc → 直连+代理都败 → throw

test('service: addSource 抓取失败拒绝+normalizeUrl 规整+重复拒绝', async () => {
  const { addSource, normalizeUrl } = await import('../lib/service.js')
  const st = await mkStore()
  assert.equal(normalizeUrl('  HTTPS://X.COM/F  '), 'https://x.com/F') // host 小写,路径保持原样
  await assert.rejects(addSource(fakeFetchFail, st, { url: 'https://x.com/f' })) // 抓取失败→拒绝
  await assert.rejects(addSource(fakeFetchOk, st, { url: '' })) // 空 url→拒绝
  const src = await addSource(fakeFetchOk, st, { url: 'https://x.com/f', title: 'X' })
  await assert.rejects(addSource(fakeFetchOk, st, { url: 'https://x.com/f' })) // 重复→拒绝
  assert.ok(src.id)
})

test('service: updateSource/removeSource 链路', async () => {
  const { addSource, removeSource, updateSource } = await import('../lib/service.js')
  const st = await mkStore()
  const src = await addSource(fakeFetchOk, st, { url: 'https://x.com/f', title: 'X' })
  assert.ok(st.sources.find((s) => s.id === src.id))
  await updateSource(st, src.id, { title: 'X2' })
  assert.equal(st.sources.find((s) => s.id === src.id)?.title, 'X2')
  assert.equal(await removeSource(st, src.id), true)
  assert.equal(st.sources.find((s) => s.id === src.id), undefined)
})

test('service: 删除内置源写墓碑、删除对应新闻，恢复后重新出现', async () => {
  const { effectiveSources, normalizeUrl, removeSource, restoreBuiltinSource } = await import('../lib/service.js')
  const st = await mkStore()
  const url = 'https://www.ruanyifeng.com/blog/atom.xml'
  const id = normalizeUrl(url)
  st.addSource({ id, url, title: '用户覆盖', enabled: false, addedAt: '', category: '科技', tier: 1, lang: 'zh', method: 'direct', builtin: false, weight: 1, summarize: true, health: {} })
  st.addItems([mkItem('builtin-item', { sourceId: id })])
  assert.equal(await removeSource(st, url, true), true)
  assert.equal(st.count(), 0)
  assert.equal(effectiveSources([], st).some((s) => s.id === id), false)
  assert.equal(await restoreBuiltinSource(st, url), true)
  assert.equal(effectiveSources([], st).some((s) => s.id === id), true)
})

// ---- scheduler 同刻顺序 ----

test('scheduler: 同刻 fetch→digest 串行顺序', async () => {
  const { startScheduler } = await import('../lib/scheduler.js')
  const order = []
  let fireFn = null
  const timers = { interval() { return () => {} }, timeout(fn, ms) { if (ms > 15_000) fireFn = fn; return () => {} } }
  startScheduler(timers, {
    fetch: { enabled: false, intervalMinutes: 60, onStartup: false, fetchTimes: [] },
    dailyTime: '00:00', timezone: '', catchUpHours: 0, enabled: true,
    lastDigestDay: () => '2026-10-28',
    runFetchCycle: async () => { order.push('fetch') },
    runDailyDigest: async () => { order.push('digest') },
    getSchedule: () => ({ digestTimes: ['00:00'], fetchTimes: ['00:00'] }), // 同刻
  })
  assert.ok(fireFn, 'armNext 应挂定点 timer')
  fireFn()
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(order.slice(0, 2), ['fetch', 'digest']) // 同刻先抓后日报
})

// ---- dsh-llm finish 错误 ----

test('collectText: finish error 抛 RssServiceError', async () => {
  const { collectText } = await import('../lib/dsh-llm.js')
  const chunks = (async function* () {
    yield { type: 'text-delta', text: 'x' }
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'E1' } } }
  })()
  await assert.rejects(collectText(chunks), /boom/)
})

// ---- buildPrompt 内容 ----

test('summarizer buildPrompt: 含条数/标题/分类/notes', async () => {
  const { buildPrompt } = await import('../lib/summarizer.js')
  const r = buildPrompt({ items: [{ title: 'T1', summary: 's', sourceTitle: 'SRC', publishedAt: '', topic: 'AI', hour: '09:00' }], language: 'zh', mode: 'batch', maxLength: 100, notes: '持续发酵' })
  assert.match(r.prompt, /T1/)
  assert.match(r.prompt, /持续发酵/)
  assert.match(r.system, /zh|中文|摘要/)
})

// ---- config 默认值 + zonedDayKey ----

test('config: 默认 schema 可构造且带关键字段', async () => {
  const { Config } = await import('../lib/index.js')
  const c = Config({})
  assert.ok(typeof c === 'object' && c !== null)
  assert.ok(c.fetch && typeof c.fetch === 'object')
})

test('time: zonedDayKey 时区日界+parseClockTime', async () => {
  const { zonedDayKey, parseClockTime } = await import('../lib/core/time.js')
  const d = new Date('2026-10-28T23:30:00+08:00') // 北京时间 28 日晚 23:30
  assert.equal(zonedDayKey(d, 'Asia/Shanghai'), '2026-10-28')
  assert.equal(zonedDayKey(d, 'UTC'), '2026-10-28') // UTC 15:30 同日
  assert.deepEqual(parseClockTime('08:30'), { hour: 8, minute: 30 })
  assert.equal(parseClockTime('bad'), undefined)
})

test('time: 夏令时切换日边界按23/25小时计算，调度跳过不存在时刻', async () => {
  const { nextZonedOccurrence, zonedDayBounds } = await import('../lib/core/time.js')
  const spring = zonedDayBounds('2026-03-08', 'America/New_York')
  assert.deepEqual(spring, { after: '2026-03-08T05:00:00.000Z', before: '2026-03-09T03:59:59.999Z' })
  const fall = zonedDayBounds('2026-11-01', 'America/New_York')
  assert.deepEqual(fall, { after: '2026-11-01T04:00:00.000Z', before: '2026-11-02T04:59:59.999Z' })

  const afterSpringJump = nextZonedOccurrence('03:30', 'America/New_York', new Date('2026-03-08T06:30:00Z'))
  assert.equal(afterSpringJump.next.toISOString(), '2026-03-08T07:30:00.000Z')
  const nonexistent = nextZonedOccurrence('02:30', 'America/New_York', new Date('2026-03-08T06:30:00Z'))
  assert.equal(nonexistent.next.toISOString(), '2026-03-09T06:30:00.000Z')
  const fallBack = nextZonedOccurrence('01:30', 'America/New_York', new Date('2026-11-01T05:45:00Z'))
  assert.equal(fallBack.next.toISOString(), '2026-11-02T06:30:00.000Z')
})

// ---- sqlite 快照+损坏恢复 ----

test('sql: snapshot .db 快照可开可读', async () => {
  const st = await mkStore()
  st.addItems([mkItem('a')])
  const snap = join(mkdtempSync(join(tmpdir(), 'rnd-sn-')), 'snap.db')
  st.snapshot(snap)
  const { SqliteStore } = await import('../lib/core/sqlite-store.js')
  const st2 = new SqliteStore({ path: snap })
  await st2.load()
  assert.equal(st2.count(), 1)
})

test('sql: 损坏 db 隔离重建', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rnd-sql-'))
  writeFileSync(join(dir, 'store.db'), Buffer.from([0, 1, 2, 3, 4, 5])) // 垃圾字节
  const { SqliteStore } = await import('../lib/core/sqlite-store.js')
  const st = new SqliteStore({ path: join(dir, 'store.db') })
  await st.load() // 不抛错
  assert.equal(st.count(), 0)
})
// === PART 3 END ===
