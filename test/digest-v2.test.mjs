import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mkItem = (id, over = {}) => ({
  id: `i${id}`, title: `news ${id}`, link: `https://x/${id}`, summary: `s${id}`,
  topic: '科技', sourceId: 'src1', publishedAt: '2026-01-01', fetchedAt: new Date().toISOString(),
  hash: `h${id}`, digestedDay: '', score: 0, reasons: [], state: { read: false, hidden: false, liked: 0 }, ...over,
})

const mkStore = async (items) => {
  const { Store } = await import('../lib/core/store.js')
  const dir = mkdtempSync(join(tmpdir(), 'rnd-v2-'))
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
  language: 'zh', timezone: '', digestsDir: mkdtempSync(join(tmpdir(), 'rnd-dg2-')),
  log: { info() {}, warn() {}, error() {} }, ...over,
})

// 万能 mock client：按 system 关键词分流（评分/条目块/总结/翻译）
const mkClient = (handler) => ({ generateText: async (req) => handler(req) })

const blocksHandler = (req) => {
  if (req.system.includes('新闻价值评审')) {
    // 给所有候选打分（序号=输入顺序），默认 8 分全过阈值
    const n = (req.prompt.match(/^\d+\./gm) || []).length
    return JSON.stringify(Array.from({ length: n }, (_, i) => ({ i: i + 1, s: 8, r: 'ok' })))
  }
  if (req.system.includes('资深新闻编辑')) return '{"summary":"要点P","background":"背景B","impact":"结论T"}'
  if (req.system.includes('翻译助手')) return '标题：译文\n正文：译文正文'
  return '整段总结'
}

test('v2: LLM 评分驱动排序 + minLlmScore 过滤', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore([mkItem(1), mkItem(2, { title: 'trivial stuff' })])
  const doc = await runDailyDigest(mkOpts(store, {
    llmClient: mkClient((req) => req.system.includes('新闻价值评审')
      ? '[{"i":1,"s":9,"r":"大事"},{"i":2,"s":3,"r":"琐碎"}]' // i=输入序：启发式第一给9分、第二给3分
      : blocksHandler(req)),
  }))
  // 第二候选 llmScore=3 < minLlmScore=5 → 只留一个条目
  assert.equal(doc.itemCount, 1)
  assert.match(doc.markdown, /评分 9/)
})

test('v2: LLM 评分失败回退启发式，仍产出', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore([mkItem(1), mkItem(2)])
  const dead = mkClient((req) => { if (req.system.includes('新闻价值评审')) throw new Error('llm dead'); return blocksHandler(req) })
  const doc = await runDailyDigest(mkOpts(store, { llmClient: dead }))
  assert.equal(doc.itemCount, 2) // 启发式兜底全留
})

test('v2: 结构化条目块渲染三段', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore([mkItem(1)])
  const doc = await runDailyDigest(mkOpts(store, { llmClient: mkClient(blocksHandler) }))
  assert.match(doc.markdown, /> 摘要：要点P/)
  assert.match(doc.markdown, /> 背景：背景B/)
  assert.match(doc.markdown, /> 影响：结论T/)
})

test('v2: 分类定制指令进入 system prompt', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore([mkItem(1, { topic: '科学' })])
  let seenSystem = ''
  const spy = mkClient((req) => { if (req.system.includes('写三块')) seenSystem = req.system; return blocksHandler(req) })
  await runDailyDigest(mkOpts(store, { llmClient: spy }))
  assert.match(seenSystem, /发现了什么、证据强度如何/)
})

test('v2: 同题合并——相似标题合并为一条并标 dupCount', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore([
    mkItem(1, { title: 'OpenAI releases GPT-6 model' }),
    mkItem(2, { title: 'OpenAI releases GPT-6 model today', sourceId: 'src1' }),
    mkItem(3, { title: 'Completely different story' }),
  ])
  const doc = await runDailyDigest(mkOpts(store, { llmClient: mkClient(blocksHandler), digestItems: 10 }))
  assert.match(doc.markdown, /同题 2 家报道/)
  assert.equal(doc.itemCount, 2) // 3 条 → 合并后 2 条
})

test('v2: dedupeStories=false 关闭合并', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore([
    mkItem(1, { title: 'OpenAI releases GPT-6 model' }),
    mkItem(2, { title: 'OpenAI releases GPT-6 model today' }),
  ])
  const doc = await runDailyDigest(mkOpts(store, { llmClient: mkClient(blocksHandler), dedupeStories: false, digestItems: 10 }))
  assert.ok(doc.itemCount >= 2)
})

test('v2: categoryPrompts 用户覆盖优先于内置默认', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore([mkItem(1, { topic: '科学' })])
  let seen = ''
  const spy = mkClient((req) => { if (req.system.includes('写三块')) seen = req.system; return blocksHandler(req) })
  await runDailyDigest(mkOpts(store, { llmClient: spy, categoryPrompts: { '科学': '重点讲商业价值' } }))
  assert.match(seen, /重点讲商业价值/)
  assert.doesNotMatch(seen, /证据强度/)
})

test('v2: aiBlocks 解析失败回退纯文本 aiSummary，不丢条目', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore([mkItem(1)])
  const plainText = mkClient((req) => req.system.includes('写三块') ? '这不是JSON的摘要文本' : blocksHandler(req))
  const doc = await runDailyDigest(mkOpts(store, { llmClient: plainText }))
  assert.equal(doc.itemCount, 1)
  const it = store.items[0]
  assert.equal(it.aiBlocks, undefined)
  assert.match(it.aiSummary, /这不是JSON/)
  assert.match(doc.markdown, /这不是JSON/) // 一行摘要渲染兜底
})

test('v2: llmScoreCandidates=0 关闭 LLM 评分（纯启发式）', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore([mkItem(1), mkItem(2)])
  let scoreCalls = 0
  const spy = mkClient((req) => { if (req.system.includes('新闻价值评审')) scoreCalls++; return blocksHandler(req) })
  const doc = await runDailyDigest(mkOpts(store, { llmClient: spy, llmScoreCandidates: 0 }))
  assert.equal(scoreCalls, 0)
  assert.equal(doc.itemCount, 2)
})

test('v2: LLM 分驱动重排——低启发式分但高 LLM 分的排前', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  // item2 更旧（启发式分低），但 LLM 给 10 分 → 应排在 item1 前
  const older = new Date(Date.now() - 20 * 3600e3).toISOString()
  const store = await mkStore([
    mkItem(1, { title: 'fresh minor update', fetchedAt: new Date().toISOString() }),
    mkItem(2, { title: 'older big story', fetchedAt: older }),
  ])
  const doc = await runDailyDigest(mkOpts(store, {
    llmClient: mkClient((req) => req.system.includes('新闻价值评审')
      ? '[{"i":1,"s":6},{"i":2,"s":10}]' : blocksHandler(req)), // 双过阈值，验证纯排序
  }))
  const p1 = doc.markdown.indexOf('fresh minor update')
  const p2 = doc.markdown.indexOf('older big story')
  assert.ok(p2 > 0 && p1 > 0 && p2 < p1, 'LLM 高分条目应排在前')
})

test('v2: CJK 标题同题合并（bigram 相似度）', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore([
    mkItem(1, { title: 'OpenAI发布GPT-6模型引发关注' }),
    mkItem(2, { title: 'OpenAI发布GPT-6模型引发热议' }),
  ])
  const doc = await runDailyDigest(mkOpts(store, { llmClient: mkClient(blocksHandler) }))
  assert.match(doc.markdown, /同题 2 家报道/)
})

test('v2: 陈旧 llmScore/aiBlocks 在 LLM 关闭时被清除、不渲染评分', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const stale = mkItem(1)
  stale.llmScore = 9; stale.aiBlocks = { summary: '旧摘要', background: '旧', impact: '旧' }
  const store = await mkStore([stale])
  const doc = await runDailyDigest(mkOpts(store, { llmEnabled: false, summaryEnabled: false }))
  assert.equal(stale.llmScore, undefined) // 清残留
  assert.doesNotMatch(doc.markdown, /评分 9/) // 不渲染旧徽标
  assert.equal(stale.aiBlocks, undefined)
})

test('v2: perTopicLimit>0 配额截断 + 溢出补齐不空缺', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  // 5 条 AI + 1 条科技，perTopicLimit=1, digestItems=3 → AI 只进 1 条，溢出补齐到 3
  const items = [1, 2, 3, 4, 5].map((i) => mkItem(i, { topic: 'AI' }))
  items.push(mkItem(6, { topic: '科技' }))
  const store = await mkStore(items)
  const doc = await runDailyDigest(mkOpts(store, {
    llmEnabled: false, summaryEnabled: false, perTopicLimit: 1, digestItems: 3,
  }))
  assert.equal(doc.itemCount, 3)
})

test('v2: 被合并的 dup 条目也标已推——次日不再入候选', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const d1 = mkItem(1, { title: 'OpenAI releases GPT-6 model' })
  const d2 = mkItem(2, { title: 'OpenAI releases GPT-6 model today' })
  const store = await mkStore([d1, d2])
  await runDailyDigest(mkOpts(store, { llmClient: mkClient(blocksHandler) }))
  assert.ok(d1.digestedDay && d2.digestedDay, 'dup 条目也被标已推')
})

test('v2: LLM 语义聚类——措辞不同的同事件合并', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore([
    mkItem(1, { title: 'Fed raises interest rates by 25bp' }),
    mkItem(2, { title: 'US central bank hikes benchmark 25 basis points' }),
    mkItem(3, { title: 'Totally unrelated news item' }),
  ])
  const cluster = mkClient((req) => {
    if (req.system.includes('同一事件')) return '[[1,2]]'
    return blocksHandler(req)
  })
  const doc = await runDailyDigest(mkOpts(store, { llmClient: cluster }))
  assert.match(doc.markdown, /同题 2 家报道/)
})
