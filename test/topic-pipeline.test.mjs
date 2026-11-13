import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const T = '../lib/topic-pipeline.js'
const mkItem = (id, over = {}) => ({
  id, sourceId: 's1', title: `标题 ${id}`, link: `https://x/${id}`,
  summary: `这是 ${id} 的摘要正文，足够长用于内容归一化判别`, content: '',
  publishedAt: '2026-11-01T08:00:00Z', fetchedAt: '2026-11-01T09:00:00Z',
  hash: `h${id}`, digestedDay: '', topic: 'AI', score: 0.9, reasons: [],
  state: { read: false, hidden: false, liked: 0 }, ...over,
})
const mkParams = (over = {}) => ({
  keywords: ['ai'], from: '', to: '', sourceIds: [], focus: '', minScore: 0, maxItems: 100, ...over,
})
const mkMeta = (over = {}) => ({
  id: 't1', title: '专题', keywords: ['ai'], from: '', to: '', sourceIds: [], focus: '',
  minScore: 0, maxItems: 100, createdAt: '2026-11-08T10:00:00Z', updatedAt: '2026-11-08T10:00:00Z',
  hitCount: 0, dedupCount: 0, itemCount: 0, usedCount: 0, durationMs: 0,
  degraded: false, excerpt: '', status: 'generating', ...over,
})
const mkStore = (byKw, spy) => ({ // byKw: { kw: FeedItem[] } 或统一数组
  queryItems: (o) => {
    spy?.(o)
    const items = Array.isArray(byKw) ? byKw : (byKw[o.q] || [])
    return { total: items.length, items: items.slice(0, o.pageSize ?? 50) }
  },
})
const srcMap = new Map([['s1', { title: '源一' }], ['s2', { title: '源二' }]])

// ---------- normalizeTopicParams ----------

test('topic: 参数归一化——默认/关键词必填/日期交换/白名单', async () => {
  const { normalizeTopicParams } = await import(T)
  const bad = normalizeTopicParams({ keywords: [] })
  assert.equal(bad.ok, false)
  const ok = normalizeTopicParams({ keywords: [' a ', 'a', 'b'], from: '2026-11-10', to: '2026-11-01' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.params.keywords, ['a', 'b']) // trim+去重
  assert.equal(ok.params.from, '2026-11-01') // 写反自动交换
  assert.equal(ok.params.to, '2026-11-10')
  assert.equal(ok.params.maxItems, 100)
  assert.equal(normalizeTopicParams({ keywords: ['x'], minScore: 4 }).ok, false)
  assert.equal(normalizeTopicParams({ keywords: ['x'], maxItems: 75 }).ok, false)
  assert.equal(normalizeTopicParams({ keywords: ['x'], minScore: 7, maxItems: 500 }).ok, true)
})

// ---------- queryTopicCandidates ----------

test('topic: 候选——关键词并集去重 + 过滤参数下推', async () => {
  const { queryTopicCandidates } = await import(T)
  const calls = []
  const a = mkItem('a'), b = mkItem('b'), c = mkItem('c')
  const store = mkStore({ openai: [a, b], 'gpt-5': [b, c] }, (o) => calls.push(o))
  const r = queryTopicCandidates(store, mkParams({ keywords: ['openai', 'gpt-5'], sourceIds: ['s1'], minScore: 5, from: '2026-11-01', to: '2026-11-08' }), 'Asia/Shanghai')
  assert.deepEqual(r.items.map((i) => i.id).sort(), ['a', 'b', 'c']) // b 并集去重
  assert.equal(r.hitCount, 3)
  assert.equal(calls.length, 2) // 逐关键词各一次
  assert.deepEqual(calls[0].sources, ['s1'])
  assert.equal(calls[0].minScore, 5)
  assert.ok(calls[0].publishedAfter && calls[0].publishedBefore) // 日界已换算
})

test('topic: 候选——标题同题去重（Jaccard）保高分主条目', async () => {
  const { queryTopicCandidates } = await import(T)
  const hi = mkItem('hi', { title: 'OpenAI releases GPT-6 model today', llmScore: 9, summary: '正文甲 '.repeat(30) })
  const lo = mkItem('lo', { title: 'OpenAI releases GPT-6 model', llmScore: 2, summary: '正文乙 '.repeat(30) })
  const r = queryTopicCandidates(mkStore([lo, hi]), mkParams())
  assert.equal(r.dedupCount, 1)
  assert.equal(r.items[0].id, 'hi') // 按 keyOf 降序排在前者成为主条目
  assert.equal(r.items[0].dupCount, 1)
})

test('topic: 候选——内容同文去重（标题不同、正文一致）', async () => {
  const { queryTopicCandidates } = await import(T)
  const body = '某厂商发布新模型基准测试全面领先业界水平 '.repeat(10)
  const hi = mkItem('hi', { title: '新模型基准领先', llmScore: 9, summary: body })
  const lo = mkItem('lo', { title: 'Benchmark 屠榜：新模型来了', llmScore: 1, summary: `  ${body}  ` }) // 空白差异同键
  const other = mkItem('x', { title: '完全不同的另一条新闻', llmScore: 8, summary: '别的内容 '.repeat(40) })
  const r = queryTopicCandidates(mkStore([lo, hi, other]), mkParams())
  assert.equal(r.dedupCount, 2)
  assert.equal(r.items[0].id, 'hi')
  assert.equal(r.items[0].dupCount, 1)
})

test('topic: 候选——入文 cap 按评分截断', async () => {
  const { queryTopicCandidates } = await import(T)
  const items = Array.from({ length: 8 }, (_, i) => mkItem(`i${i}`, { llmScore: i + 1 }))
  const r = queryTopicCandidates(mkStore(items), mkParams({ maxItems: 50 }))
  assert.equal(r.items.length, 8)
  // cap 语义在 store pageSize：mock 校验下推的 pageSize=cap
  const calls = []
  queryTopicCandidates(mkStore(items, (o) => calls.push(o)), mkParams({ maxItems: 50 }))
  assert.equal(calls[0].pageSize, 50)
})

// ---------- [N] 引用解析 ----------

test('topic: [N] 解析——合法→链接；越界/零→整标记丢弃不猜', async () => {
  const { parseTopicCitations } = await import(T)
  const items = [mkItem('a', { title: '甲新闻' }), mkItem('b', { title: '乙新闻' })]
  const r = parseTopicCitations('事件经过 [1]，另有分析 [2] 与幻觉 [9]、[0]、[abc] 不解析。', items)
  assert.ok(r.text.includes('[1](https://x/a)'))
  assert.ok(r.text.includes('[2](https://x/b)'))
  assert.ok(!r.text.includes('[9]') && !r.text.includes('[0]')) // 越界编号整标丢弃
  assert.ok(r.text.includes('[abc]')) // 非数字标不是 [N] 协议，原样保留
  assert.deepEqual(r.used.map((i) => i.id), ['a', 'b'])
})

test('topic: [N] 解析——同编号多次引用 used 去重', async () => {
  const { parseTopicCitations } = await import(T)
  const items = [mkItem('a'), mkItem('b'), mkItem('c')]
  const r = parseTopicCitations('x [1] y [1] z [3]', items)
  assert.deepEqual(r.used.map((i) => i.id), ['a', 'c'])
})

test('topic: reflow——超长行按句读切段，列表/标题/短行不动，** 标记不切断', async () => {
  const { reflowTopicBody } = await import(T)
  const s = (n, ch = '字') => Array.from({ length: n }, () => ch).join('')
  const long = `${s(300)}。${s(300)}。${s(300)}。`
  const r = reflowTopicBody(`## 概述\n\n${long}\n\n- ${s(150)}项。${s(300)}。${s(300)}。\n\n**${s(380)}**${s(80)}。`)
  const parts = r.split('\n\n').map((x) => x.trim())
  assert.ok(parts[1].length <= 420 && parts[2].length <= 420 && parts[3].length <= 420) // 900 字行切成 ≤420 字段
  const bullets = parts[4].split('\n') // 超长列表项拆成多条 bullet
  assert.ok(bullets.length > 1 && bullets.every((b) => b.startsWith('- ') && b.length <= 422))
  assert.ok(r.startsWith('## 概述'))
  const boldPara = parts.find((p) => p.includes('**'))
  assert.equal((boldPara.match(/\*\*/g) || []).length % 2, 0) // 含粗体的段标记成对
})

// ---------- 标题消毒 / 摘要 ----------

test('topic: LLM 标题消毒——首行+去壳+截断', async () => {
  const { sanitizeTopicTitle } = await import(T)
  assert.equal(sanitizeTopicTitle('## 「GPT-5 时代的开发者生态」\n第二行忽略'), 'GPT-5 时代的开发者生态')
  assert.equal(sanitizeTopicTitle('\n\n  '), '')
  assert.equal(sanitizeTopicTitle('标题很长。'), '标题很长')
})

test('topic: excerpt 取概述节纯文本', async () => {
  const { topicExcerpt } = await import(T)
  const body = '## 概述\n\n本周 [OpenAI 发布](https://x/a) 了新模型。\n\n## 要点分析\n\n分析内容不该进来'
  const ex = topicExcerpt(body)
  assert.equal(ex, '本周 OpenAI 发布 了新模型。')
})

// ---------- renderTopic ----------

test('topic: render——meta 行/参考区/零引用省略/降级标注', async () => {
  const { renderTopic } = await import(T)
  const items = [mkItem('a', { llmScore: 8 }), mkItem('b', { llmScore: 6, sourceId: 's2' })] // 跨两源→源计数=2
  const full = renderTopic({
    title: '周报', keywords: ['ai'], from: '2026-11-01', to: '2026-11-08', focus: '',
    hitCount: 10, dedupCount: 5, itemCount: 2, usedItems: [items[0]], items,
    sourcesById: srcMap, body: '## 概述\n\n正文。', createdAt: '2026-11-08T10:00:00Z', durationMs: 3200, degraded: false,
  })
  assert.ok(full.startsWith('# 周报'))
  assert.ok(full.includes('2 条入文（命中 10 · 去重后 5） · 2 源'))
  assert.ok(full.includes('## 参考新闻（1 条）'))
  assert.ok(full.includes('1. [标题 a](https://x/a)'))
  const noRefs = renderTopic({
    title: 't', keywords: ['ai'], from: '', to: '', focus: '',
    hitCount: 1, dedupCount: 1, itemCount: 1, usedItems: [], items,
    sourcesById: srcMap, body: 'b', createdAt: '2026-11-08T10:00:00Z', durationMs: 100, degraded: true,
  })
  assert.ok(!noRefs.includes('参考新闻')) // K'=0 省略整节
  assert.ok(noRefs.includes('未捕获引用'))
  assert.ok(noRefs.includes('降级产出'))
})

// ---------- index/文件操作 ----------

test('topic: index 读写/懒修复/删除/导出', async () => {
  const { writeTopicsIndex, readTopicsIndex, upsertTopicMeta, listTopics, deleteTopic, exportTopic, topicsDirOf, safeFileStem } = await import(T)
  const dir = mkdtempSync(join(tmpdir(), 'rnd-topic-'))
  const digests = join(dir, 'digests')
  await writeTopicsIndex(digests, [mkMeta({ id: 't1' })])
  assert.equal((await readTopicsIndex(digests)).length, 1)
  await upsertTopicMeta(digests, mkMeta({ id: 't2' })) // 新条目排最前
  assert.equal((await readTopicsIndex(digests))[0].id, 't2')
  // 懒修复：无 activeId 时 generating→error
  let list = await listTopics(digests)
  assert.equal(list.find((m) => m.id === 't1').status, 'error')
  assert.equal(list.find((m) => m.id === 't1').error, '进程重启中断')
  // 重置后带 activeId 不修复
  await writeTopicsIndex(digests, [mkMeta({ id: 't1' }), mkMeta({ id: 'act' })])
  list = await listTopics(digests, { activeId: 'act' })
  assert.equal(list.find((m) => m.id === 'act').status, 'generating')
  assert.equal(list.find((m) => m.id === 't1').status, 'error')
  // queued 懒修复：在内存队列的放行，不在的（重启丢队列）→ error
  await writeTopicsIndex(digests, [mkMeta({ id: 'q1', status: 'queued' }), mkMeta({ id: 'q2', status: 'queued' })])
  list = await listTopics(digests, { queuedIds: ['q1'] })
  assert.equal(list.find((m) => m.id === 'q1').status, 'queued')
  assert.equal(list.find((m) => m.id === 'q2').status, 'error')
  assert.equal(list.find((m) => m.id === 'q2').error, '排队被进程重启中断')
  // 导出文件名消毒
  assert.equal(safeFileStem('a/b:c*d'), 'a b c d')
  mkdirSync(topicsDirOf(digests), { recursive: true })
  await writeTopicsIndex(digests, [mkMeta({ id: 't1', status: 'done', title: '测试/标题' })])
  writeFileSync(join(topicsDirOf(digests), 't1.md'), '# body')
  const f = await exportTopic(digests, 't1', join(dir, 'out'))
  assert.ok(f.endsWith('.md') && !f.includes('/标题'))
  assert.equal(readFileSync(f, 'utf8'), '# body')
  assert.equal(await deleteTopic(digests, 't1'), true)
  assert.equal(existsSync(join(topicsDirOf(digests), 't1.md')), false)
})

// ---------- runTopicPipeline ----------

test('topic: 管线端到端——LLM 成文+起名+引用+落盘+meta done', async () => {
  const { runTopicPipeline } = await import(T)
  const dir = mkdtempSync(join(tmpdir(), 'rnd-topic-'))
  const items = [mkItem('a', { title: '甲新闻', llmScore: 8 }), mkItem('b', { title: '乙新闻', llmScore: 6 })]
  const calls = []
  const llmClient = {
    async generateText(req) {
      calls.push(req.purpose)
      if (req.purpose === 'topic-merge') return '## 概述\n\n本周发生了大事 [1]。\n\n## 要点分析\n\n深入分析 [2]。'
      if (req.purpose === 'topic-title') return 'AI 周报'
      return '- 要点 [1]'
    },
  }
  const meta = await runTopicPipeline({
    store: mkStore(items), params: mkParams(), meta: mkMeta(),
    llmClient, llmEnabled: true, summaryConcurrency: 1, llmTimeoutMs: 5000, llmMaxTokens: 500,
    sourcesById: srcMap, digestsDir: join(dir, 'digests'),
  })
  assert.equal(meta.status, 'done')
  assert.equal(meta.title, 'AI 周报')
  assert.equal(meta.usedCount, 2)
  assert.equal(meta.hitCount, 2)
  const md = readFileSync(join(dir, 'digests', 'topics', 't1.md'), 'utf8')
  assert.ok(md.includes('# AI 周报'))
  assert.ok(md.includes('[1](https://x/a)'))
  assert.ok(md.includes('## 参考新闻（2 条）'))
  assert.deepEqual(calls, ['topic-merge', 'topic-title']) // ≤1 批直通合并契约（不跑 chunk）
})

test('topic: 管线分批——>25 条走 chunk+merge，引用跨批连续', async () => {
  const { runTopicPipeline } = await import(T)
  const dir = mkdtempSync(join(tmpdir(), 'rnd-topic-'))
  const items = Array.from({ length: 30 }, (_, i) => mkItem(`i${i}`, { llmScore: 5 }))
  const calls = []
  const llmClient = {
    async generateText(req) {
      calls.push(req.purpose)
      if (req.purpose === 'topic-chunk') return '- 批要点 [1] [26]'
      if (req.purpose === 'topic-merge') return '## 概述\n\n合并成文 [26]。'
      return '标题'
    },
  }
  const meta = await runTopicPipeline({
    store: mkStore(items), params: mkParams({ maxItems: 100 }), meta: mkMeta(),
    llmClient, llmEnabled: true, summaryConcurrency: 1, llmTimeoutMs: 5000, llmMaxTokens: 500,
    sourcesById: srcMap, digestsDir: join(dir, 'digests'),
  })
  assert.equal(meta.status, 'done')
  assert.equal(calls.filter((p) => p === 'topic-chunk').length, 2) // 30 条 = 2 批
  assert.equal(meta.usedCount, 1)
  const md = readFileSync(join(dir, 'digests', 'topics', 't1.md'), 'utf8')
  assert.ok(md.includes(`[标题 i25](https://x/i25)`)) // [26] 解析到第 26 条（跨批编号）
})

test('topic: 管线降级——LLM 不可用走抽取式四节', async () => {
  const { runTopicPipeline } = await import(T)
  const dir = mkdtempSync(join(tmpdir(), 'rnd-topic-'))
  const items = [mkItem('a', { title: '甲新闻', llmScore: 8 })]
  const meta = await runTopicPipeline({
    store: mkStore(items), params: mkParams(), meta: mkMeta(),
    llmEnabled: false, summaryConcurrency: 1, llmTimeoutMs: 5000, llmMaxTokens: 500,
    sourcesById: srcMap, digestsDir: join(dir, 'digests'),
  })
  assert.equal(meta.degraded, true)
  const md = readFileSync(join(dir, 'digests', 'topics', 't1.md'), 'utf8')
  for (const s of ['## 概述', '## 背景', '## 发展脉络', '## 要点分析']) assert.ok(md.includes(s), `缺 ${s}`)
  assert.ok(md.includes('降级产出'))
})

test('topic: 管线中止——预置 abort 直接抛手动停止', async () => {
  const { runTopicPipeline } = await import(T)
  const dir = mkdtempSync(join(tmpdir(), 'rnd-topic-'))
  const ac = new AbortController(); ac.abort()
  await assert.rejects(() => runTopicPipeline({
    store: mkStore([mkItem('a')]), params: mkParams(), meta: mkMeta(),
    llmEnabled: false, summaryConcurrency: 1, llmTimeoutMs: 5000, llmMaxTokens: 500,
    sourcesById: srcMap, digestsDir: join(dir, 'digests'), signal: ac.signal,
  }), /手动停止/)
})
