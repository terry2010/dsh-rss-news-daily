import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RSS2 = `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>
<item><title>News A</title><link>https://a.example/1</link><guid>a-1</guid></item>
<item><title>News B</title><link>https://a.example/2</link><guid>a-2</guid></item>
</channel></rss>`

const mkStore = async () => {
  const { Store } = await import('../lib/core/store.js')
  const st = new Store({ path: join(mkdtempSync(join(tmpdir(), 'rnd-svc-')), 's.json') })
  await st.load()
  return st
}

const mkSource = (over = {}) => ({
  id: 'https://x/feed', url: 'https://x/feed', title: 'X', enabled: true, addedAt: '',
  category: 'AI', tier: 1, lang: 'en', method: 'direct', builtin: true, weight: 1,
  health: { ok: 0, fail: 0, failStreak: 0 }, ...over,
})

test('runFetchCycle: 多源并发、单源失败就地标注、健康度累计', async () => {
  const { runFetchCycle } = await import('../lib/service.js')
  const store = await mkStore()
  const fetch = async (url) => url.includes('bad')
    ? { url, status: 0, error: 'boom', retryable: false }
    : { url, status: 200, body: RSS2 }
  const good = mkSource()
  const bad = mkSource({ id: 'https://bad/feed', url: 'https://bad/feed' })
  const r = await runFetchCycle({
    fetch, store, sources: [good, bad],
    maxItemsPerSource: 50, storeContentChars: 4000,
    concurrency: 2, dedupeThreshold: 0.85, log: { info() {}, warn() {}, error() {} },
  })
  assert.equal(r.totalAdded, 2)
  assert.equal(r.errors, 1)
  assert.equal(store.items.length, 2)
  assert.equal(good.health.ok, 1)
  assert.equal(bad.health.failStreak, 1)
  assert.ok(bad.health.lastError?.includes('boom'))
  assert.equal(store.items[0].topic, 'AI')
  assert.equal(store.items[0].state.read, false)
})

test('runFetchCycle: 二轮抓取不重复入库（id+hash 去重）', async () => {
  const { runFetchCycle } = await import('../lib/service.js')
  const store = await mkStore()
  const fetch = async (url) => ({ url, status: 200, body: RSS2 })
  const opts = { fetch, store, sources: [mkSource()], maxItemsPerSource: 50, storeContentChars: 4000, concurrency: 1, dedupeThreshold: 0.85 }
  const r1 = await runFetchCycle(opts)
  const r2 = await runFetchCycle(opts)
  assert.equal(r1.totalAdded, 2)
  assert.equal(r2.totalAdded, 0)
  assert.equal(r2.sources[0].duplicated, 2)
  assert.equal(store.items.length, 2)
})

test('runFetchCycle: 冷却中的源被跳过', async () => {
  const { runFetchCycle } = await import('../lib/service.js')
  const store = await mkStore()
  let calls = 0
  const fetch = async (url) => { calls++; return { url, status: 200, body: RSS2 } }
  const cooling = mkSource({ health: { ok: 0, fail: 3, failStreak: 3, cooldownUntil: new Date(Date.now() + 3600e3).toISOString() } })
  const r = await runFetchCycle({ fetch, store, sources: [cooling], maxItemsPerSource: 50, storeContentChars: 4000, concurrency: 1, dedupeThreshold: 0.85 })
  assert.equal(calls, 0)
  assert.equal(r.sources.length, 0)
})

test('runFetchCycle: 连续3次失败触发冷却', async () => {
  const { runFetchCycle } = await import('../lib/service.js')
  const store = await mkStore()
  const fetch = async (url) => ({ url, status: 0, error: 'down', retryable: false })
  const src = mkSource({ health: { ok: 0, fail: 2, failStreak: 2 } })
  await runFetchCycle({ fetch, store, sources: [src], maxItemsPerSource: 50, storeContentChars: 4000, concurrency: 1, dedupeThreshold: 0.85 })
  assert.equal(src.health.failStreak, 3)
  assert.ok(src.health.cooldownUntil, 'cooldownUntil should be set after 3rd consecutive failure')
})

test('effectiveSources: 内置 ∪ config ∪ store 合并，用户覆盖内置', async () => {
  const { effectiveSources, normalizeUrl } = await import('../lib/service.js')
  const store = await mkStore()
  const builtinUrl = 'https://www.ruanyifeng.com/blog/atom.xml'
  store.addSource(mkSource({ url: builtinUrl, id: normalizeUrl(builtinUrl), builtin: false, enabled: false, weight: 2, title: 'X用户改' }))
  const list = effectiveSources([], store)
  assert.ok(list.length >= 51, `builtin sources missing: ${list.length}`)
  const overridden = list.find((s) => s.id === normalizeUrl(builtinUrl))
  assert.equal(overridden.enabled, false)
  assert.equal(overridden.builtin, true)
  const extra = effectiveSources([{ url: 'https://extra.example/feed?x=1', title: 'E' }], store)
  assert.ok(extra.some((s) => normalizeUrl(s.url) === 'https://extra.example/feed?x=1'))
})

test('normalizeUrl: 去追踪参数与大小写', async () => {
  const { normalizeUrl } = await import('../lib/service.js')
  assert.equal(normalizeUrl('HTTPS://Ex.com/A/?utm_source=x&b=1'), 'https://ex.com/A?b=1')
  assert.equal(normalizeUrl('https://a.com/f#frag'), 'https://a.com/f')
})
