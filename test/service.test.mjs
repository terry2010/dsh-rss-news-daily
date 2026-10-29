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

test('runFetchCycle: 取消会中止当前请求、不拉取队列余项且不累计源故障', async () => {
  const { runFetchCycle } = await import('../lib/service.js')
  const store = await mkStore()
  const controller = new AbortController()
  const started = []
  let notifyStarted
  const began = new Promise((resolve) => { notifyStarted = resolve })
  const fetch = (url, signal) => new Promise((resolve) => {
    started.push(url)
    notifyStarted()
    signal.addEventListener('abort', () => resolve({ url, status: 0, error: 'aborted', retryable: false }), { once: true })
  })
  const sources = [mkSource(), mkSource({ id: 'https://y/feed', url: 'https://y/feed' })]
  const pending = runFetchCycle({
    fetch, store, sources, signal: controller.signal,
    maxItemsPerSource: 50, storeContentChars: 4000, concurrency: 1, dedupeThreshold: 0.85,
  })
  await began
  controller.abort()
  const result = await pending
  assert.deepEqual(started, [sources[0].url])
  assert.equal(result.sources[0].error, undefined)
  assert.equal(sources[0].health.fail, 0)
  assert.equal(sources[1].health.fail, 0)
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

test('健康度落 store.health 表：纯内置源冷却跨轮/跨重启生效', async () => {
  const { runFetchCycle, effectiveSources } = await import('../lib/service.js')
  const { Store } = await import('../lib/core/store.js')
  const dir = mkdtempSync(join(tmpdir(), 'rnd-hp-'))
  const file = join(dir, 's.json')
  const store = new Store({ path: file })
  await store.load()
  const fetch = async (url) => ({ url, status: 0, error: 'down', retryable: false })
  const src = mkSource({ health: { ok: 0, fail: 2, failStreak: 2 } })
  await runFetchCycle({ fetch, store, sources: [src], maxItemsPerSource: 50, storeContentChars: 4000, concurrency: 1, dedupeThreshold: 0.85 })
  assert.equal(store.getHealth(src.id).failStreak, 3, 'health 必须落到 store.health 表')
  // 模拟重启：新 Store 重读文件，health 表应持久化保留
  const st2 = new Store({ path: file })
  await st2.load()
  assert.equal(st2.getHealth(src.id)?.failStreak, 3, '重启后 health 表应保留 failStreak')
  assert.ok(st2.getHealth(src.id)?.cooldownUntil)
})

test('畸形 store 数据不崩整轮（health:5 消毒）', async () => {
  const { runFetchCycle } = await import('../lib/service.js')
  const { Store } = await import('../lib/core/store.js')
  const { writeFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'rnd-bad-'))
  const file = join(dir, 's.json')
  writeFileSync(file, JSON.stringify({ schema: 1, meta: {}, sources: [{ url: 'https://x/feed', id: 'i', title: 'x', enabled: true, addedAt: '', health: 5 }], items: [], health: {} }))
  const store = new Store({ path: file })
  await store.load()
  const fetch = async (url) => ({ url, status: 200, body: RSS2 })
  const r = await runFetchCycle({ fetch, store, sources: effectiveSanitized(store), maxItemsPerSource: 50, storeContentChars: 4000, concurrency: 1, dedupeThreshold: 0.85 })
  assert.equal(r.errors, 0)
  assert.equal(r.totalAdded, 2)
})

function effectiveSanitized(store) {
  return store.sources.map((s) => ({ ...s, tier: 1, lang: 'en', method: 'direct', weight: 1, topic: 'x' }))
}

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
  assert.equal(overridden.title, 'X用户改', '改名应以用户为准')
  const extra = effectiveSources([{ url: 'https://extra.example/feed?x=1', title: 'E' }], store)
  assert.ok(extra.some((s) => normalizeUrl(s.url) === 'https://extra.example/feed?x=1'))
})

test('normalizeUrl: 去追踪参数与大小写', async () => {
  const { normalizeUrl } = await import('../lib/service.js')
  assert.equal(normalizeUrl('HTTPS://Ex.com/A/?utm_source=x&b=1'), 'https://ex.com/A?b=1')
  assert.equal(normalizeUrl('https://a.com/f#frag'), 'https://a.com/f')
})
