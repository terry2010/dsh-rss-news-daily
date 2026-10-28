import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mkStore = async (opts = {}) => {
  const { Store } = await import('../lib/core/store.js')
  const st = new Store({ path: join(mkdtempSync(join(tmpdir(), 'rnd-cov-')), 's.json'), ...opts })
  await st.load()
  return st
}
const mkItem = (id, over = {}) => ({
  id, sourceId: 's1', title: `T-${id}`, link: `https://x/${id}`, summary: `s${id}`,
  publishedAt: '2026-01-01', fetchedAt: new Date().toISOString(), hash: `h${id}`, digestedDay: '',
  topic: 'AI', score: 0, reasons: [], state: { read: false, hidden: false, liked: 0 }, ...over,
})

// ---- Store.prune: 保留天数 ----

test('prune: retentionDays 过期清理', async () => {
  const old = new Date(Date.now() - 100 * 86400e3).toISOString() // 100 天前
  const st = await mkStore({ maxItems: 10, retentionDays: () => 90 })
  st.addItems([mkItem('old', { fetchedAt: old }), mkItem('new')])
  await st.save()
  assert.equal(st.items.length, 1)
  assert.equal(st.items[0].id, 'new')
})

test('prune: retentionDays=0 不按时间过期', async () => {
  const old = new Date(Date.now() - 100 * 86400e3).toISOString()
  const st = await mkStore({ maxItems: 10, retentionDays: () => 0 }) // 无数量压力
  st.addItems([mkItem('old', { fetchedAt: old }), mkItem('n1')])
  await st.save()
  assert.equal(st.items.length, 2) // 天数过期不生效,老条目存活
})

test('prune: 低质优先——llmScore 最低的先被砍', async () => {
  const st = await mkStore({ maxItems: 2, retentionDays: () => 0, pruneLowQuality: () => true })
  st.addItems([mkItem('lo', { llmScore: 2 }), mkItem('hi', { llmScore: 9 }), mkItem('mid', { llmScore: 6 })])
  await st.save()
  assert.equal(st.items.length, 2)
  assert.equal(st.items.find((i) => i.id === 'lo'), undefined) // 最低分被砍
  assert.ok(st.items.find((i) => i.id === 'hi'))
  assert.ok(st.items.find((i) => i.id === 'mid'))
})

test('prune: 低质优先关闭→最老先走', async () => {
  const st = await mkStore({ maxItems: 2, retentionDays: () => 0, pruneLowQuality: () => false })
  st.addItems([mkItem('oldest', { fetchedAt: '2026-01-01T00:00:00Z', llmScore: 9 }), mkItem('mid', { fetchedAt: '2026-01-02T00:00:00Z' }), mkItem('new', { fetchedAt: '2026-01-03T00:00:00Z' })])
  await st.save()
  assert.equal(st.items.find((i) => i.id === 'oldest'), undefined) // 高分但最老仍被砍
})

// ---- token 统计 ----

test('addTokenStats: 按日+按功能累计,零用量跳过', async () => {
  const { addTokenStats } = await import('../lib/core/token-stats.js')
  const meta = {}
  addTokenStats(meta, 'digest', { inputTokens: 100, outputTokens: 50 }, '2026-10-28')
  addTokenStats(meta, 'score', { inputTokens: 20, outputTokens: 10 }, '2026-10-28')
  addTokenStats(meta, 'digest', { inputTokens: 10, outputTokens: 5 }, '2026-10-29')
  addTokenStats(meta, 'digest', { inputTokens: 0, outputTokens: 0 }, '2026-10-29') // 零用量跳过
  assert.equal(meta.tokenStats.totalIn, 130)
  assert.equal(meta.tokenStats.totalOut, 65)
  assert.equal(meta.tokenStats.days['2026-10-28'].digest, 150)
  assert.equal(meta.tokenStats.days['2026-10-28'].score, 30)
  assert.equal(meta.tokenStats.days['2026-10-29'].digest, 15)
})

// ---- /items sort 参数 ----

const mkRes = () => ({ statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b ?? '' } })
const mkReq = (method, url, body) => ({
  method, url, headers: {},
  on(ev, cb) { if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') setImmediate(cb) },
})
const findH = (regs, path) => regs.find((r) => r.path === path)?.handler

test('api /items: sort=fetched 按抓取时间,默认按发布时间', async () => {
  const { mountApi } = await import('../lib/api.js')
  const st = await mkStore()
  // 同一条:publishedAt 老但 fetchedAt 新 vs publishedAt 新但 fetchedAt 老
  st.addItems([
    mkItem('oldPub', { publishedAt: '2026-01-01T00:00:00Z', fetchedAt: '2026-10-28T12:00:00Z' }),
    mkItem('newPub', { publishedAt: '2026-10-27T00:00:00Z', fetchedAt: '2026-10-27T08:00:00Z' }),
  ])
  const regs = []; mountApi({ register: (o) => { regs.push(o); return () => {} } }, {
    store: st, prefs: { get: () => ({}), set: async () => {} }, readerPageSize: 50,
  })
  const items = findH(regs, '/dsh-rss-news-daily/api/items')
  let res = mkRes()
  await items(mkReq('GET', '/dsh-rss-news-daily/api/items'), res)
  assert.equal(JSON.parse(res.body).items[0].id, 'newPub') // published 序:newPub 在前
  res = mkRes()
  await items(mkReq('GET', '/dsh-rss-news-daily/api/items?sort=fetched'), res)
  assert.equal(JSON.parse(res.body).items[0].id, 'oldPub') // fetched 序:oldPub 在前
})

// ---- 调度器 ----

test('scheduler: 轮询+定点+启动抓取的 timer 装配', async () => {
  const { startScheduler } = await import('../lib/scheduler.js')
  const calls = []
  const timers = { interval(fn, ms) { calls.push(['interval', ms]); return () => {} }, timeout(fn, ms) { calls.push(['timeout', ms]); return () => {} } }
  startScheduler(timers, {
    fetch: { enabled: true, intervalMinutes: 60, onStartup: true, fetchTimes: [] },
    dailyTime: '09:00', timezone: '', catchUpHours: 6, enabled: true,
    lastDigestDay: () => '2026-10-28',
    runFetchCycle: async () => ({}), runDailyDigest: async () => ({}),
    getSchedule: () => ({ digestTimes: [], fetchTimes: ['20:00'] }),
  })
  assert.ok(calls.find(([k, ms]) => k === 'interval' && ms === 3600_000)) // 轮询间隔=60min
  assert.ok(calls.find(([k, ms]) => k === 'timeout' && ms === 10_000)) // onStartup 延迟抓
  assert.ok(calls.filter(([k, ms]) => k === 'timeout' && ms > 10_000).length >= 1) // 定点 armNext
})
test('scheduler: 轮询<5min 不挂 interval', async () => {
  const { startScheduler } = await import('../lib/scheduler.js')
  const calls = []
  const timers = { interval(fn, ms) { calls.push(['interval', ms]); return () => {} }, timeout(fn, ms) { calls.push(['timeout', ms]); return () => {} } }
  startScheduler(timers, {
    fetch: { enabled: true, intervalMinutes: 1, onStartup: false, fetchTimes: [] },
    dailyTime: '09:00', timezone: '', catchUpHours: 0, enabled: true,
    lastDigestDay: () => '2026-10-28',
    runFetchCycle: async () => ({}), runDailyDigest: async () => ({}),
  })
  assert.equal(calls.filter(([k]) => k === 'interval').length, 0)
})

// ---- /api/prefs POST 合并语义 ----

test('api /prefs POST: 显式字段才落盘,undefined 不清已学权重', async () => {
  const { mountApi } = await import('../lib/api.js')
  const { PrefsStore } = await import('../lib/core/prefs.js')
  const prefs = new PrefsStore(join(mkdtempSync(join(tmpdir(), 'rnd-pr-')), 'p.json'))
  prefs.save({ topics: { AI: 1.5 }, bannedKeywords: ['x'] })
  const regs = []; mountApi({ register: (o) => { regs.push(o); return () => {} } }, {
    store: await mkStore(), prefs, readerPageSize: 50,
  })
  const h = findH(regs, '/dsh-rss-news-daily/api/prefs')
  const res = mkRes()
  await h(mkReq('POST', '/dsh-rss-news-daily/api/prefs', { autoTranslate: true }), res)
  const saved = prefs.get()
  assert.equal(saved.autoTranslate, true)
  assert.equal(saved.topics?.AI, 1.5) // 未提字段保留
  assert.deepEqual(saved.bannedKeywords, ['x'])
})

test('api /prefs POST: subscribedTopics=[] 显式清空(非保留)', async () => {
  const { mountApi } = await import('../lib/api.js')
  const { PrefsStore } = await import('../lib/core/prefs.js')
  const prefs = new PrefsStore(join(mkdtempSync(join(tmpdir(), 'rnd-pr-')), 'p.json'))
  prefs.save({ subscribedTopics: ['AI', '财经'] })
  const regs = []; mountApi({ register: (o) => { regs.push(o); return () => {} } }, {
    store: await mkStore(), prefs, readerPageSize: 50,
  })
  const h = findH(regs, '/dsh-rss-news-daily/api/prefs')
  const res = mkRes()
  await h(mkReq('POST', '/dsh-rss-news-daily/api/prefs', { subscribedTopics: [] }), res)
  assert.deepEqual(prefs.get().subscribedTopics, []) // 空数组=清空订阅=全部入池
})

// ---- scheduler 补跑 ----

test('scheduler: 错过日报且在 catchUpHours 内→补跑', async () => {
  const { startScheduler } = await import('../lib/scheduler.js')
  const calls = []
  const timers = { interval(fn, ms) { calls.push(['interval', ms]); return () => {} }, timeout(fn, ms) { calls.push(['timeout', ms]); return () => {} } }
  startScheduler(timers, {
    fetch: { enabled: false, intervalMinutes: 60, onStartup: false, fetchTimes: [] },
    dailyTime: '08:00', timezone: '', catchUpHours: 24, enabled: true,
    lastDigestDay: () => '2026-10-27', // 昨天生成过,今天没生成
    runFetchCycle: async () => ({}),
    runDailyDigest: async () => ({}),
    getSchedule: () => ({ digestTimes: [], fetchTimes: [] }),
  })
  assert.ok(calls.find(([k, ms]) => k === 'timeout' && ms === 15_000)) // 补跑 timer 已挂(CATCHUP_DELAY_MS=15s)
})

test('scheduler: 今天已生成日报→不补跑', async () => {
  const { startScheduler } = await import('../lib/scheduler.js')
  const calls = []
  const timers = { interval(fn, ms) { calls.push(['interval', ms]); return () => {} }, timeout(fn, ms) { calls.push(['timeout', ms]); return () => {} } }
  startScheduler(timers, {
    fetch: { enabled: false, intervalMinutes: 60, onStartup: false, fetchTimes: [] },
    dailyTime: '08:00', timezone: '', catchUpHours: 24, enabled: true,
    lastDigestDay: () => new Date().toISOString().slice(0, 10), // 今天已生成
    runFetchCycle: async () => ({}),
    runDailyDigest: async () => ({}),
    getSchedule: () => ({ digestTimes: [], fetchTimes: [] }),
  })
  assert.equal(calls.filter(([k, ms]) => k === 'timeout' && ms === 15_000).length, 0) // 已生成→不挂补跑 timer
})
