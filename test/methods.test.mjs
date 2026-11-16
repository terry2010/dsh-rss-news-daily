import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mkStore = async () => {
  const { Store } = await import('../lib/core/store.js')
  const st = new Store({ path: join(mkdtempSync(join(tmpdir(), 'rnd-method-')), 's.json') })
  await st.load()
  return st
}

const baseOpts = (store, sources, fetch) => ({
  fetch: fetch ?? (async () => ({ url: '', status: 200, body: '' })),
  store, sources,
  maxItemsPerSource: 50, storeContentChars: 4000, concurrency: 2, dedupeThreshold: 0.6,
})

test('method handler: 非标源经注册表走通去重/入库/健康度全管线', async () => {
  const { runFetchCycle, toFeedSource } = await import('../lib/service.js')
  const { registerMethod } = await import('../lib/core/methods.js')
  const store = await mkStore()
  let sawKv = false
  registerMethod('test:noop', async (src, ctx) => {
    sawKv = ctx.kv !== undefined
    ctx.kv.set('cursor', '1')
    return [{ id: 't1', title: 'Flash A', link: 'https://x.example/1', content: 'c', publishedAt: new Date().toISOString() }]
  })
  const src = toFeedSource({ url: 'https://flash.example/x', title: 'Flash', method: 'test:noop', provider: 'test-pkg', lang: 'zh', category: '快讯' })
  const res = await runFetchCycle(baseOpts(store, [src]))
  assert.equal(res.totalAdded, 1)
  assert.equal(res.errors, 0)
  assert.equal(sawKv, true)
  assert.equal(src.provider, 'test-pkg')
  assert.equal((store.meta.methodState ??= {})[src.id]?.cursor, '1')
})

test('unknown method: 走既有健康度降级不误伤其他源', async () => {
  const { runFetchCycle, toFeedSource } = await import('../lib/service.js')
  const { registerMethod } = await import('../lib/core/methods.js')
  const store = await mkStore()
  registerMethod('test:ok', async () => [{ id: 'ok1', title: 'OK Item' }])
  const bad = toFeedSource({ url: 'https://flash.example/bad', title: 'Bad', method: 'nope:x' })
  const good = toFeedSource({ url: 'https://flash.example/good', title: 'Good', method: 'test:ok' })
  const res = await runFetchCycle(baseOpts(store, [bad, good]))
  assert.equal(res.totalAdded, 1)
  assert.match(res.sources.find((s) => s.sourceId === bad.id)?.error ?? '', /unknown method/)
  assert.equal(store.getHealth(bad.id)?.failStreak, 1)
})

test('addSources→store：provider 落源、URL 去重', async () => {
  const { toFeedSource, normalizeUrl } = await import('../lib/service.js')
  const store = await mkStore()
  const existing = new Set(store.sources.map((s) => normalizeUrl(s.url)))
  const defs = [
    { url: 'https://flash.example/a', title: 'A', method: 'test:ok', category: '快讯', tier: 1, lang: 'zh', summarize: false },
    { url: 'https://flash.example/a/', title: 'A-dup' }, // 规范化后同 URL——应被跳过
  ]
  let n = 0
  for (const d of defs) {
    const key = normalizeUrl(d.url)
    if (existing.has(key)) continue
    store.addSource(toFeedSource({ ...d, builtin: false, provider: 'test-pkg' }))
    existing.add(key); n += 1
  }
  assert.equal(n, 1)
  const saved = store.sources.find((s) => normalizeUrl(s.url) === 'https://flash.example/a')
  assert.equal(saved?.provider, 'test-pkg')
  assert.equal(saved?.summarize, false)
  assert.equal(saved?.method, 'test:ok')
})

test('stream 标志：SourceDef→FeedSource 透传，缺省 undefined', async () => {
  const { toFeedSource } = await import('../lib/service.js')
  const s = toFeedSource({ url: 'https://flash.example/s', title: 'S', method: 'test:ok', stream: true, summarize: false })
  assert.equal(s.stream, true)
  const n = toFeedSource({ url: 'https://flash.example/n', title: 'N' })
  assert.equal(n.stream, false)
})
