import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mkItem = (id, over = {}) => ({
  id: `i${id}`, title: `news ${id}`, link: `https://x/${id}`, summary: `s${id}`,
  topic: '科技', sourceId: 'src1', publishedAt: '2026-01-01', fetchedAt: new Date().toISOString(),
  hash: `h${id}`, digestedDay: '', score: 0, reasons: [], state: { read: false, hidden: false, liked: 0 }, ...over,
})
const mkStore = async (items) => {
  const { Store } = await import('../lib/core/store.js')
  const dir = mkdtempSync(join(tmpdir(), 'rnd-sof-'))
  const store = new Store({ path: join(dir, 'store.json'), log: { info() {}, warn() {}, error() {} } })
  await store.load()
  store.items.push(...items)
  store.addSource({ id: 'src1', url: 'https://x/f', title: 'Src1', category: '科技', enabled: true, builtin: false, summarize: true, addedAt: '', health: { ok: 1, fail: 0, failStreak: 0 } })
  return store
}
const mkOpts = (store, over = {}) => ({
  store, configSources: [], llmEnabled: true, summaryEnabled: true,
  summaryMaxItems: 20, summaryConcurrency: 2, summaryMaxLength: 50,
  llmTimeoutMs: 60_000, llmMaxTokens: 4096,
  digestItems: 5, perTopicLimit: 0, digestMaxLength: 800,
  llmScoreCandidates: 40, minLlmScore: 5, dedupeStories: true,
  language: 'zh', timezone: '', digestsDir: mkdtempSync(join(tmpdir(), 'rnd-dg3-')),
  log: { info() {}, warn() {}, error() {} }, ...over,
})
const mkClient = (handler) => ({ generateText: async (req) => handler(req) })
const scoreHandler = (req) => {
  const n = (req.prompt.match(/^\d+\./gm) || []).length
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({ i: i + 1, s: 8, r: 'ok', t: ['T'] })))
}
const noopLog = { info() {}, warn() {}, error() {} }

test('sof: scoreNewItems 分块评分写 llmScore/tags，dupOf 不送评分', async () => {
  const { scoreNewItems } = await import('../lib/digest-pipeline.js')
  const items = [mkItem(1), mkItem(2), mkItem(3)]
  items[1].title = items[0].title // 同题 → dupOf
  const calls = []
  const client = mkClient((req) => { calls.push(req); return scoreHandler(req) })
  const n = await scoreNewItems(items, client, { llmTimeoutMs: 60_000, llmScoreCandidates: 40, llmMaxTokens: 4096 }, noopLog)
  assert.equal(n, 2) // item1+item3 评出（item2 被并）
  assert.equal(items[0].llmScore, 8)
  assert.equal(items[0].tags[0], 'T')
  assert.ok(items[1].dupOf) // 被并条目标记
  assert.equal(items[1].llmScore, undefined) // 未送评分
})

test('sof: 已评分条目幂等跳过', async () => {
  const { scoreNewItems } = await import('../lib/digest-pipeline.js')
  const items = [mkItem(1, { llmScore: 7 }), mkItem(2)]
  const calls = []
  const client = mkClient((req) => { calls.push(req); return scoreHandler(req) })
  await scoreNewItems(items, client, { llmTimeoutMs: 60_000, llmScoreCandidates: 40, llmMaxTokens: 4096 }, noopLog)
  assert.equal(items[0].llmScore, 7) // 未被覆盖
  assert.equal(items[1].llmScore, 8)
})

test('sof: 评分 prompt 带分类 + 偏好注入', async () => {
  const { scoreNewItems } = await import('../lib/digest-pipeline.js')
  const calls = []
  const client = mkClient((req) => { calls.push(req); return scoreHandler(req) })
  await scoreNewItems([mkItem(1, { topic: 'AI' })], client, {
    llmTimeoutMs: 60_000, llmScoreCandidates: 40, llmMaxTokens: 4096,
    prefs: { topics: { AI: 2.0 }, keywords: {}, bannedKeywords: ['裁员'], sourceWeight: {} },
  }, noopLog)
  assert.match(calls[0].prompt, /\[AI\] news 1/)
  assert.match(calls[0].system, /特别关注：AI/)
  assert.match(calls[0].system, /屏蔽：裁员/)
})

test('sof: pickFinal 无分条目不受阈值过滤、按启发式竞争', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  // item1 高分有评分(8)；item2 无分但启发式强 → 无分也能入选（未评≠低分）
  const store = await mkStore([mkItem(1, { llmScore: 8 }), mkItem(2, { title: 'unique topic news' }), mkItem(3, { llmScore: 3, title: 'zzz low' })])
  const doc = await runDailyDigest(mkOpts(store, {
    llmEnabled: false, summaryEnabled: false, rescoreMissing: false,
  }))
  assert.equal(doc.itemCount >= 2, true)
  assert.doesNotMatch(doc.markdown, /zzz low/) // 有分3<阈值5被过滤
})

test('sof: rescoreMissing 补评无分候选并写回', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const it = mkItem(1)
  const store = await mkStore([it])
  await runDailyDigest(mkOpts(store, { llmClient: mkClient(scoreHandler), summaryEnabled: false }))
  assert.equal(it.llmScore, 8) // 补评写回
})

test('sof: subscribedTopics 过滤未订阅分类', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore([mkItem(1, { topic: 'AI' }), mkItem(2, { topic: '财经' })])
  const doc = await runDailyDigest(mkOpts(store, {
    llmEnabled: false, summaryEnabled: false, subscribedTopics: ['AI'], digestItems: 10,
  }))
  assert.equal(doc.itemCount, 1)
  assert.match(doc.markdown, /news 1/)
  assert.doesNotMatch(doc.markdown, /news 2/)
})

test('sof: 领域分块渲染 + 领域速览', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore([mkItem(1, { topic: 'AI' }), mkItem(2, { topic: '财经', title: 'finance story' })])
  const doc = await runDailyDigest(mkOpts(store, {
    llmClient: mkClient((req) => req.system.includes('新闻价值评审') ? scoreHandler(req) : '领域摘要文本'),
    digestItems: 10,
  }))
  assert.match(doc.markdown, /## 领域速览/)
  assert.match(doc.markdown, /### AI/)
  assert.match(doc.markdown, /### 财经/)
})

test('sof: appendHourlyBrief 按节追加+同刻覆盖幂等', async () => {
  const { appendHourlyBrief } = await import('../lib/digest-pipeline.js')
  const dir = mkdtempSync(join(tmpdir(), 'rnd-hb-'))
  const srcMap = new Map([['src1', { title: 'Src1' }]])
  const items = [mkItem(1, { llmScore: 8 }), mkItem(2, { llmScore: 4 })]
  const base = { items, sourcesById: srcMap, day: '2026-10-28', digestsDir: dir, minScore: 6, log: noopLog }
  await appendHourlyBrief({ ...base, time: '09:00' })
  await appendHourlyBrief({ ...base, time: '10:00' })
  let md = readFileSync(join(dir, '2026-10-28-hourly.md'), 'utf8')
  assert.match(md, /## 09:00 时段快报/)
  assert.match(md, /## 10:00 时段快报/)
  assert.match(md, /评分 8/)
  assert.doesNotMatch(md, /评分 4/) // 低分不入快报
  await appendHourlyBrief({ ...base, time: '09:00' }) // 同刻覆盖不重复
  md = readFileSync(join(dir, '2026-10-28-hourly.md'), 'utf8')
  assert.equal((md.match(/## 09:00/g) || []).length, 1)
})

test('sof: 评分块失败不阻塞后续块', async () => {
  const { scoreNewItems } = await import('../lib/digest-pipeline.js')
  const items = [mkItem(1), mkItem(2), mkItem(3), mkItem(4)]
  let call = 0
  const client = mkClient((req) => {
    call++
    if (call === 1) throw new Error('llm down')
    return scoreHandler(req)
  })
  // chunkSize=2 → 2 块；第 1 块抛错，第 2 块照常评出
  const n = await scoreNewItems(items, client, { llmTimeoutMs: 60_000, llmScoreCandidates: 2, llmMaxTokens: 4096 }, noopLog)
  assert.equal(call, 2)
  assert.equal(n, 2)
  assert.equal(items[2].llmScore, 8)
  assert.equal(items[0].llmScore, undefined)
})

test('sof: 全部有分时 digest 零评分调用', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore([mkItem(1, { llmScore: 8 }), mkItem(2, { llmScore: 6, title: 'other story' })])
  let scoreCalls = 0
  const client = mkClient((req) => {
    if (req.system.includes('新闻价值评审')) scoreCalls++
    return req.system.includes('新闻价值评审') ? scoreHandler(req) : '摘要'
  })
  await runDailyDigest(mkOpts(store, { llmClient: client, summaryEnabled: false }))
  assert.equal(scoreCalls, 0) // 有分不补评——零评分调用
})
