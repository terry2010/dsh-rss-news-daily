import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mk = async (opts = {}) => {
  const { SqliteStore } = await import('../lib/core/sqlite-store.js')
  const dir = mkdtempSync(join(tmpdir(), 'rnd-sql-'))
  const st = new SqliteStore({ path: join(dir, 'store.db'), maxItems: 10, ...opts })
  await st.load()
  return { st, dir }
}
const mkItem = (id, over = {}) => ({
  id, sourceId: 's1', title: `T-${id}`, link: `https://x/${id}`, summary: `sum ${id}`, content: '',
  publishedAt: '2026-01-01', fetchedAt: new Date().toISOString(), hash: `h${id}`, digestedDay: '',
  topic: 'AI', score: 0, reasons: [], state: { read: false, hidden: false, liked: 0 }, ...over,
})

test('sql: probeSqlite 探测 node:sqlite+FTS5', async () => {
  const { probeSqlite } = await import('../lib/core/sqlite-store.js')
  const r = probeSqlite()
  assert.equal(r.ok, true)
  assert.equal(r.fts, true)
})

test('sql: addItems 去重(hash)+count+窗口', async () => {
  const { st } = await mk()
  assert.equal(st.addItems([mkItem('a'), mkItem('b')]), 2)
  assert.equal(st.addItems([mkItem('a')]), 0) // hash 重复忽略
  assert.equal(st.count(), 2)
  assert.equal(st.items.length, 2)
})

test('sql: 删除订阅源时删除其全部历史新闻并同步 FTS/内存窗口', async () => {
  const { st } = await mk()
  const source = { id: 'https://x/feed', url: 'https://x/feed', title: 'X', enabled: true, addedAt: '', category: 'AI', tier: 1, lang: 'en', method: 'direct', builtin: false, weight: 1, summarize: true, proxy: null, health: {} }
  st.addSource(source)
  st.addItems([mkItem('a', { sourceId: source.id, title: '删除源新闻测试' }), mkItem('b', { sourceId: 'other' })])
  assert.equal(st.removeSource(source.id), true)
  assert.equal(st.count(), 1)
  assert.equal(st.items.length, 1)
  assert.equal(st.items[0].id, 'b')
  assert.equal(st.queryItems({ q: '删除源新闻' }).total, 0)
})

test('sql: 老 store.json 归档+sources 保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rnd-sql-'))
  const legacy = join(dir, 'store.json')
  writeFileSync(legacy, JSON.stringify({ sources: [{ id: 'u1', url: 'https://u/feed', title: 'U', enabled: true, addedAt: '', category: 'AI', tier: 1, lang: 'zh', method: 'direct', builtin: false, weight: 1, summarize: true }] }))
  const { SqliteStore } = await import('../lib/core/sqlite-store.js')
  const st = new SqliteStore({ path: join(dir, 'store.db') })
  await st.load()
  assert.ok(existsSync(`${legacy}.migrated`))
  assert.equal(st.sources.find((s) => s.id === 'u1')?.url, 'https://u/feed')
  assert.equal(st.items.length, 0) // 条目不迁
})

test('sql: save 持久化窗口内修改（state/meta）', async () => {
  const { st, dir } = await mk()
  st.addItems([mkItem('a')])
  st.items[0].state.read = true
  st.meta.lastFetchAt = '2026-10-28T00:00:00Z'
  await st.save()
  const { SqliteStore } = await import('../lib/core/sqlite-store.js')
  const st2 = new SqliteStore({ path: join(dir, 'store.db') })
  await st2.load()
  assert.equal(st2.items[0].state.read, true)
  assert.equal(st2.meta.lastFetchAt, '2026-10-28T00:00:00Z')
})

test('sql: prune 过期+低质优先', async () => {
  const old = new Date(Date.now() - 100 * 86400e3).toISOString()
  const { st } = await mk({ maxItems: 2, retentionDays: () => 90, pruneLowQuality: () => true })
  st.addItems([mkItem('exp', { fetchedAt: old })])
  await st.save()
  assert.equal(st.count(), 0) // 过期砍
  st.addItems([mkItem('lo', { llmScore: 1 }), mkItem('hi', { llmScore: 9 }), mkItem('mid', { llmScore: 5 })])
  await st.save()
  assert.equal(st.count(), 2)
  assert.equal(st.items.find((i) => i.id === 'lo'), undefined) // 低质先走
})

test('sql: queryItems filter+sort+分页', async () => {
  const { st } = await mk()
  st.addItems([
    mkItem('a', { topic: 'AI', fetchedAt: '2026-10-28T10:00:00Z' }),
    mkItem('b', { topic: '财经', fetchedAt: '2026-10-28T11:00:00Z' }),
    mkItem('c', { topic: 'AI', fetchedAt: '2026-10-27T09:00:00Z', publishedAt: '2026-10-28T01:00:00Z' }),
  ])
  let r = st.queryItems({ category: 'AI' })
  assert.equal(r.total, 2)
  r = st.queryItems({ day: '2026-10-28' })
  assert.equal(r.total, 2) // c 是 27 号抓的不算
  r = st.queryItems({ sort: 'published' })
  assert.equal(r.items[0].id, 'c') // published 序:c 最新
  r = st.queryItems({ sort: 'fetched' })
  assert.equal(r.items[0].id, 'b') // fetched 序:b 最新
  r = st.queryItems({ pageSize: 2, page: 2 })
  assert.equal(r.total, 3); assert.equal(r.items.length, 1)
})

test('sql: fetchedAfter 单独过滤用于实时本轮新增计数', async () => {
  const { st } = await mk()
  st.addItems([
    mkItem('before', { fetchedAt: '2026-10-28T09:59:59.999Z' }),
    mkItem('during-1', { fetchedAt: '2026-10-28T10:00:00.000Z' }),
    mkItem('during-2', { fetchedAt: '2026-10-28T10:00:01.000Z' }),
  ])
  const r = st.queryItems({ fetchedAfter: '2026-10-28T10:00:00.000Z', fetchedBefore: '9999-12-31', pageSize: 1 })
  assert.equal(r.total, 2)
  assert.equal(r.items.length, 1)
})

test('sql: FTS 中文子串搜索（trigram）', async () => {
  const { st } = await mk()
  st.addItems([mkItem('z', { title: '苹果手机发布新款芯片', summary: '性能提升' })])
  let r = st.queryItems({ q: '苹果手机' })
  assert.equal(r.total, 1) // trigram 3+字符子串命中
  r = st.queryItems({ q: '苹果' })
  assert.equal(r.total, 1) // <3字符降级 LIKE 也能命中
})

test('sql: NDJSON 导出→导入 roundtrip+幂等', async () => {
  const { st, dir } = await mk()
  st.addItems([mkItem('a'), mkItem('b')])
  st.addSource({ id: 'u1', url: 'https://u/f', title: 'U', enabled: true, addedAt: '', category: 'AI', tier: 1, lang: 'zh', method: 'direct', builtin: false, weight: 1, summarize: true, proxy: null, health: {} })
  const digests = join(dir, 'digests')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(digests, { recursive: true })
  writeFileSync(join(digests, '2026-10-28-rss-briefing.md'), '# daily')
  writeFileSync(join(digests, '2026-10-28-hourly.md'), '# hourly')
  const f = join(dir, 'exp.ndjson')
  const n = await st.exportNdjson(f, digests)
  assert.equal(n, 2)
  // 新库导入
  const { SqliteStore } = await import('../lib/core/sqlite-store.js')
  const dir2 = mkdtempSync(join(tmpdir(), 'rnd-sql-'))
  const st2 = new SqliteStore({ path: join(dir2, 'store.db') })
  await st2.load()
  const c = await st2.importNdjson(f, join(dir2, 'digests'))
  assert.equal(c.items, 2); assert.equal(c.sources, 1); assert.equal(c.digests, 2)
  assert.equal(st2.count(), 2)
  const c2 = await st2.importNdjson(f, join(dir2, 'digests')) // 幂等：重复导入 0 新增
  assert.equal(c2.items, 0)
})

test('sql: markDigested + countUndigested', async () => {
  const { st } = await mk()
  st.addItems([mkItem('a'), mkItem('b')])
  st.markDigested(['a'], '2026-10-28')
  assert.equal(st.countUndigested('2026-10-28'), 1)
})
