import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mkStore = async () => {
  const { Store } = await import('../lib/core/store.js')
  const st = new Store({ path: join(mkdtempSync(join(tmpdir(), 'rnd-m2-')), 's.json') })
  await st.load()
  return st
}
const RSS2 = `<?xml version="1.0"?><rss version="2.0"><channel><title>FeedT</title>
<item><title>N1</title><link>https://a/1</link><guid>g1</guid></item></channel></rss>`

test('opml: 解析分组继承 category + 生成往返', async () => {
  const { parseOpml, generateOpml } = await import('../lib/core/opml.js')
  const opml = `<?xml version="1.0"?><opml version="2.0"><body>
    <outline text="AI"><outline type="rss" text="OpenAI" xmlUrl="https://openai.com/blog/rss.xml"/></outline>
    <outline text="Dev"><outline type="rss" text="HN" xmlUrl="https://hnrss.org/frontpage" htmlUrl="https://news.ycombinator.com"/></outline>
    <outline type="rss" text="Solo" xmlUrl="https://x.com/f"/>
  </body></opml>`
  const list = parseOpml(opml)
  assert.equal(list.length, 3)
  assert.equal(list[0].category, 'AI')
  assert.equal(list[1].category, 'Dev')
  assert.equal(list[2].category, undefined)
  const gen = generateOpml(list.map((e) => ({ title: e.title, url: e.xmlUrl, category: e.category })))
  const re = parseOpml(gen)
  assert.equal(re.length, 3)
  assert.equal(re.find((e) => e.xmlUrl.includes('openai')).category, 'AI')
})

test('opml: 非 OPML 抛错', async () => {
  const { parseOpml } = await import('../lib/core/opml.js')
  assert.throws(() => parseOpml('<html></html>'))
})

test('addSource: 抓取校验通过才落库，失败不落', async () => {
  const { addSource } = await import('../lib/service.js')
  const store = await mkStore()
  const okFetch = async (url) => ({ url, status: 200, body: RSS2 })
  const s = await addSource(okFetch, store, { url: 'https://new.example/feed' })
  assert.equal(s.title, 'FeedT')
  assert.equal(store.sources.length, 1)
  await assert.rejects(() => addSource(okFetch, store, { url: 'https://new.example/feed' }), /已存在/)
  const badFetch = async (url) => ({ url, status: 0, error: 'timeout' })
  await assert.rejects(() => addSource(badFetch, store, { url: 'https://dead.example/f' }), /抓取失败/)
  assert.equal(store.sources.length, 1, '失败的源不得落库')
})

test('setSourceEnabled: 内置源停用写覆盖层，恢复重启用', async () => {
  const { setSourceEnabled, effectiveSources, normalizeUrl } = await import('../lib/service.js')
  const store = await mkStore()
  const url = 'https://www.ruanyifeng.com/blog/atom.xml'
  await setSourceEnabled(store, url, false, { title: '阮一峰', category: '独立博客' })
  let list = effectiveSources([], store)
  assert.equal(list.find((s) => s.id === normalizeUrl(url)).enabled, false)
  await setSourceEnabled(store, url, true)
  list = effectiveSources([], store)
  assert.equal(list.find((s) => s.id === normalizeUrl(url)).enabled, true)
})

test('scheduler: 补跑逻辑——今日无日报且已过点且在窗口内→立即触发', async () => {
  const { startScheduler } = await import('../lib/scheduler.js')
  const timers = []
  const ctx = {
    timeout: (fn, ms) => { timers.push({ fn, ms }); return () => {} },
    interval: (fn, ms) => { timers.push({ fn, ms, interval: true }); return () => {} },
  }
  let digestRan = 0
  const now = new Date()
  const pastTime = `${String(Math.max(0, now.getHours() - 1)).padStart(2, '0')}:00`
  startScheduler(ctx, {
    fetch: { enabled: false, intervalMinutes: 60, onStartup: false },
    dailyTime: pastTime, timezone: '', catchUpHours: 12, enabled: true,
    lastDigestDay: () => '1970-01-01',
    runFetchCycle: async () => ({}), runDailyDigest: async () => { digestRan++ },
  })
  const catchup = timers.find((t) => !t.interval && t.ms < 60_000)
  assert.ok(catchup, 'catch-up timer should be armed')
  await catchup.fn(); await new Promise((r) => setImmediate(r))
  assert.equal(digestRan, 1)
})

test('scheduler: 今日日报已存在→不补跑', async () => {
  const { startScheduler } = await import('../lib/scheduler.js')
  const { zonedDayKey } = await import('../lib/core/time.js')
  const timers = []
  const ctx = { timeout: (fn, ms) => { timers.push({ fn, ms }); return () => {} }, interval: () => () => {} }
  startScheduler(ctx, {
    fetch: { enabled: false, intervalMinutes: 60, onStartup: false },
    dailyTime: '00:00', timezone: '', catchUpHours: 24, enabled: true,
    lastDigestDay: () => zonedDayKey(new Date()),
    runFetchCycle: async () => ({}), runDailyDigest: async () => {},
  })
  assert.ok(!timers.some((t) => t.ms === 15_000), 'no catch-up when digest exists')
})
