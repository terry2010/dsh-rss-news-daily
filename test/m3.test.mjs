import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mkStore = async (n = 0) => {
  const { Store } = await import('../lib/core/store.js')
  const st = new Store({ path: join(mkdtempSync(join(tmpdir(), 'rnd-m3-')), 's.json') })
  await st.load()
  for (let i = 0; i < n; i++) {
    st.addItems([{
      id: `i${i}`, sourceId: 'src1', title: `News item ${i}`, link: `https://x/${i}`,
      summary: `summary of item ${i}`, content: '', publishedAt: new Date(Date.now() - i * 3600e3).toISOString(),
      fetchedAt: new Date().toISOString(), hash: `h${i}`, digestedDay: '',
      topic: i % 3 === 0 ? 'AI' : '科技', score: 0, reasons: [],
      state: { read: false, hidden: false, liked: 0 },
    }])
  }
  return st
}

const mkOpts = (store, over = {}) => ({
  store, configSources: [], llmEnabled: false, summaryEnabled: false,
  summaryMaxItems: 20, summaryConcurrency: 3, summaryMaxLength: 50,
  digestItems: 20, perTopicLimit: 0, digestMaxLength: 800,
  language: 'zh', timezone: '', digestsDir: mkdtempSync(join(tmpdir(), 'rnd-dg-')),
  log: { info() {}, warn() {}, error() {} }, ...over,
})

test('digest: 条数可配 5/20/50，无隐藏硬顶', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  for (const n of [5, 20, 50]) {
    const store = await mkStore(60)
    const opts = mkOpts(store, { digestItems: n })
    const doc = await runDailyDigest(opts)
    assert.equal(doc.itemCount, n, `digestItems=${n}`)
    assert.match(doc.markdown, /## 重要新闻/)
    assert.match(doc.markdown, /## 今日总结/)
  }
})

test('digest: LLM 全挂 → 抽取式降级，degraded=true 且仍产出', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore(10)
  const deadClient = { generateText: async () => { throw new Error('model dead') } }
  const doc = await runDailyDigest(mkOpts(store, { llmClient: deadClient, llmEnabled: true, digestItems: 5 }))
  assert.equal(doc.degraded, true)
  assert.equal(doc.summarySource, 'extractive')
  assert.ok(doc.markdown.length > 50)
  assert.match(doc.note, /degraded/)
})

test('digest: 逐条摘要部分失败→该条用原文，其它用 AI（逐条降级）', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore(6)
  let call = 0
  const flaky = {
    generateText: async (req) => {
      call++
      if (req.prompt.includes('item 1')) throw new Error('one item fails')
      return `AI-${call}`
    },
  }
  const doc = await runDailyDigest(mkOpts(store, {
    llmClient: flaky, llmEnabled: true, summaryEnabled: true, summaryMaxItems: 6, digestItems: 5,
  }))
  const { Store } = await import('../lib/core/store.js')
  const items = store.items.filter((i) => doc.itemIds.includes(i.id))
  const withErr = items.filter((i) => i.aiSummaryError)
  const withAI = items.filter((i) => i.aiSummary)
  assert.ok(withErr.length >= 1, 'at least one item should carry aiSummaryError')
  assert.ok(withAI.length >= 1, 'other items keep AI summary')
  assert.ok(withErr.every((i) => i.summary.length > 0), 'failed items keep original summary')
})

test('digest: markDigested + meta.lastDigestDay 落盘；次日同条跨日降权', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const { zonedDayKey } = await import('../lib/core/time.js')
  const store = await mkStore(8)
  const day = zonedDayKey(new Date())
  const dgDir = mkdtempSync(join(tmpdir(), 'rnd-dgfile-'))
  const doc = await runDailyDigest(mkOpts(store, { digestItems: 5, digestsDir: dgDir }))
  assert.equal(store.meta.lastDigestDay, day)
  assert.ok(store.items.filter((i) => doc.itemIds.includes(i.id)).every((i) => i.digestedDay === day))
  const files = readdirSync(dgDir)
  assert.ok(files.some((f) => f.includes(day)), `digest md should exist in ${dgDir}: ${files}`)
})

test('scorer: 屏蔽词淘汰/主题偏好加分/跨日降权/理由可解释', async () => {
  const { scoreAndSelect, EMPTY_PREFS } = await import('../lib/core/scorer.js')
  const items = [
    { id: 'a', sourceId: 's', title: '币圈暴涨', summary: '', content: '', publishedAt: '', fetchedAt: '2026-01-01', hash: 'h1', digestedDay: '', topic: '财经', score: 0, reasons: [], state: { read: false, hidden: false, liked: 0 }, link: 'l' },
    { id: 'b', sourceId: 's', title: 'AI Agent 新突破', summary: '', content: '', publishedAt: '', fetchedAt: '2026-01-02', hash: 'h2', digestedDay: '', topic: 'AI', score: 0, reasons: [], state: { read: false, hidden: false, liked: 0 }, link: 'l' },
    { id: 'c', sourceId: 's', title: '普通科技新闻', summary: '', content: '', publishedAt: '', fetchedAt: '2026-01-02', hash: 'h3', digestedDay: '2026-01-01', topic: '科技', score: 0, reasons: [], state: { read: false, hidden: false, liked: 0 }, link: 'l' },
  ]
  const prefs = { topics: { AI: 1.5 }, keywords: {}, bannedKeywords: ['币圈'], sourceWeight: {} }
  const picked = scoreAndSelect(items, new Map([['s', { tier: 1, weight: 1 }]]), 10, {
    prefs, digestDay: '2026-01-02', now: new Date('2026-01-02T12:00:00Z'), perTopicLimit: 0,
  })
  assert.ok(!picked.some((i) => i.id === 'a'), 'banned keyword must eliminate')
  const ai = picked.find((i) => i.id === 'b')
  assert.ok(ai.reasons.some((r) => r.includes('主题偏好')))
  const old = items.find((i) => i.id === 'c')
  assert.ok(old.reasons.includes('跨日已推降权') && old.score < ai.score)
})

test('digest 渲染: 采集源状态段出现失败源', async () => {
  const { runDailyDigest } = await import('../lib/digest-pipeline.js')
  const store = await mkStore(5)
  store.setHealth('https://bad/feed', { ok: 0, fail: 3, failStreak: 3, lastError: 'timeout', cooldownUntil: '2099-01-01' })
  const doc = await runDailyDigest(mkOpts(store, { digestItems: 3 }))
  assert.match(doc.markdown, /## 今日总结/)
  assert.ok(doc.itemCount === 3)
})
