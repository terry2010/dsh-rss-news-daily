/**
 * 日报管线：候选 → 打分精选 → 逐条摘要（逐条降级）→ 整体总结（整段降级）
 * → 渲染落盘 → 标记已推 + meta.lastDigestDay。
 *
 * 铁律 2：任何一条/一段 LLM 失败只降级该处，日报永远产出。
 */

import { mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'

import type { DigestDocument, DigestLanguage, FeedItem, LogSink } from './core/types.js'
import { noopLog } from './core/types.js'
import type { Store } from './core/store.js'
import type { LlmClient } from './summarizer.js'
import { summarize } from './summarizer.js'
import type { SummarizableItem } from './summarizer.js'
import { renderDigest, digestFileName } from './digest.js'
import { scoreAndSelect } from './core/scorer.js'
import type { Prefs } from './core/scorer.js'
import { zonedDayKey } from './core/time.js'
import { effectiveSources } from './service.js'
import { truncateCodePoints } from './core/parser.js'

export interface DigestPipelineOptions {
  store: Store
  configSources: Array<{ url: string; title?: string; category?: string; enabled?: boolean }>
  llmClient?: LlmClient
  llmEnabled: boolean
  summaryEnabled: boolean
  summaryMaxItems: number
  summaryConcurrency: number
  summaryMaxLength: number
  /** LLM 单次调用超时（流挂起兜底，防 digestRunning 闩锁） */
  llmTimeoutMs: number
  /** 外部取消信号（「停止生成」）；与 llmTimeoutMs 合并为任一触发即停 */
  signal?: AbortSignal
  /** 指定生成的目标日（yyyy-mm-dd），缺省按 now 所在日 */
  day?: string
  /** 订阅分类（缺省/空=全部订阅）；不在表内的 topic 不进日报候选池 */
  subscribedTopics?: string[]
  /** 日报补评无分候选（存量/评分失败兜底），默认 true */
  rescoreMissing?: boolean
  /** 翻译用 LLM client（translateLlm 路由）；存在时对英文条目生成中英对照译文 */
  translateClient?: LlmClient
  /** 每完成一条回调（done, total, stage）——stage: summaries/translate/finishing，进度上报用 */
  onItemDone?: (done: number, total: number, stage?: string) => void
  /** LLM maxTokens（config 透传，不再用 summarizer 内算值） */
  llmMaxTokens: number
  digestItems: number
  perTopicLimit: number
  digestMaxLength: number
  language: DigestLanguage
  timezone: string
  digestsDir: string
  prefs?: Prefs
  log?: LogSink
  now?: Date
  /** 候选池 = 最近 N 小时内的条目；0=不限 */
  candidateHours?: number
  /** 跨日降权的窗口天数（dedupe.windowDays；0=不罚） */
  penaltyWindowDays?: number
  /** force 重跑：纳入当日已推条目重算（news_regen /api/digest-run force 语义） */
  force?: boolean
  /** v2：LLM 评分候选池上限（启发式粗排后取前 N）；0=关闭用纯启发式 */
  llmScoreCandidates?: number
  /** v2：LLM 评分入选阈值（1-10），评过分的低于此值不入选 */
  minLlmScore?: number
  /** v2：同题新闻合并去重（标题 token 重叠聚类） */
  dedupeStories?: boolean
  /** v2：分类→输出指令映射（覆盖内置默认） */
  categoryPrompts?: Record<string, string>
}

function toSummarizable(item: FeedItem, sourceTitle: string): SummarizableItem {
  return {
    title: item.title,
    link: item.link,
    summary: item.summary,
    content: item.content,
    sourceTitle,
    topic: item.topic,
    publishedAt: item.publishedAt,
  }
}

/** 逐条翻译：CJK 占比 ≤50% 的条目调翻译模型写 state.translation（'标题\n\n正文'），日报渲染中英对照。 */
async function translateItems(items: FeedItem[], client: LlmClient, opts: DigestPipelineOptions): Promise<void> {
  const targets = items.filter((i) => {
    const t = i.title + (i.summary || '')
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length
    return cjk * 2 <= t.replace(/\s/g, '').length
  })
  const queue = [...targets]
  let done = 0
  const workers = Array.from({ length: Math.max(1, opts.summaryConcurrency) }, async () => {
    for (;;) {
      if (opts.signal?.aborted) return
      const item = queue.shift()
      if (!item) return
      try {
        const text = await client.generateText({
          system: '你是翻译助手。把给定新闻标题和摘要翻译成简体中文，严格按此格式输出两行：\n标题：<译题>\n正文：<译文>\n只输出译文，不要解释。',
          prompt: `标题：${item.title}\n\n正文：${item.summary || item.title}`,
          maxTokens: 1200,
          signal: AbortSignal.any([AbortSignal.timeout(opts.llmTimeoutMs), ...(opts.signal ? [opts.signal] : [])]),
        })
        const m = text.match(/标题：\s*([^\n]+)\n+(?:[\s\S]*?)正文：\s*([\s\S]+)/)
        item.state.translation = m ? `${m[1].trim()}\n\n${m[2].trim()}` : text.trim()
      } catch (e) {
        item.state.translationError = e instanceof Error ? e.message : String(e)
      }
      done++
      opts.onItemDone?.(done, targets.length, 'translate')
    }
  })
  await Promise.all(workers)
}

/** v2 分类输出指令默认表：不同内容类型给不同的处理角度（Horizon profiles 轻量版）。 */
const DEFAULT_CAT_PROMPTS: Record<string, string> = {
  '国际': '这件事为什么重要、影响谁',
  '财经': '这件事为什么重要、影响谁',
  '社会·人文': '这件事为什么重要、影响谁',
  '开发': '对从业者有什么用、能直接带走什么',
  '科技': '对从业者有什么用、能直接带走什么',
  'AI': '对从业者有什么用、能直接带走什么',
  '科学': '发现了什么、证据强度如何',
  '产品': '是什么、面向谁、谁会买单',
  '综合': '核心信息是什么、价值何在',
}

/** 偏好提示段：调教权重→特别关注、banned→屏蔽（注入评分 system prompt）。 */
function buildPrefsHint(prefs?: DigestPipelineOptions['prefs']): string {
  if (!prefs) return ''
  const top = [...Object.entries(prefs.topics ?? {}), ...Object.entries(prefs.keywords ?? {})]
    .filter(([, w]) => w > 1.1).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k)
  const banned = (prefs.bannedKeywords ?? []).slice(0, 10)
  const parts: string[] = []
  if (top.length) parts.push(`用户特别关注：${top.join('、')}——相关条目可上调 1-2 档`)
  if (banned.length) parts.push(`用户明确屏蔽：${banned.join('、')}——命中建议 ≤2 分`)
  return parts.length ? `\n${parts.join('\n')}` : ''
}

/** 单块评分核心：一次批量调用给 items 打 llmScore/tags；返回评出条数（失败 0）。 */
async function scoreChunk(
  chunk: FeedItem[],
  client: LlmClient,
  opts: Pick<DigestPipelineOptions, 'llmTimeoutMs' | 'llmMaxTokens' | 'signal' | 'prefs'>,
  log: LogSink,
): Promise<number> {
  try {
    const text = await client.generateText({
      system: '你是新闻价值评审。按该条目所属领域的价值分档打分：9-10 突破（领域内原创深度/重大版本/行业变革）；7-8 高值（重要进展值得即读）；5-6 有趣（增量/教程/值得关注）；3-4 低优先（例行更新/软文）；0-2 噪声（垃圾/标题党）。不要奖励夸张标题；区分厂商宣称与已交付能力。并给每条 2-4 个主题标签。'
        + buildPrefsHint(opts.prefs)
        + ' 只输出 JSON 数组 [{"i":序号,"s":分数,"r":"10字内理由","t":["标签"]}]，不要解释。',
      prompt: chunk.map((it, idx) => `${idx + 1}. [${it.topic || '综合'}] ${it.title}`).join('\n'),
      maxTokens: 2400,
      signal: AbortSignal.any([AbortSignal.timeout(opts.llmTimeoutMs), ...(opts.signal ? [opts.signal] : [])]),
    })
    const m = text.match(/\[[\s\S]*\]/)
    const arr: Array<{ i: number; s: number; r?: string; t?: string[] }> = m ? JSON.parse(m[0]) : []
    let n = 0
    for (const e of arr) {
      const it = chunk[Number(e.i) - 1]
      if (it && typeof e.s === 'number' && e.s >= 1 && e.s <= 10) {
        it.llmScore = e.s
        if (e.r) it.llmReason = String(e.r)
        if (Array.isArray(e.t) && e.t.length) it.tags = e.t.map(String).slice(0, 4)
        n += 1
      }
    }
    log.info(`llmScore: ${n}/${chunk.length} items scored`)
    return n
  } catch (e) {
    log.warn(`scoreChunk failed: ${e instanceof Error ? e.message : e}`)
    return 0
  }
}

/** v2 LLM 评分：启发式粗排 top N 批量打分 [{i,s,r}]；覆盖过半才有效（回退启发式）。 */
async function llmScoreItems(
  items: FeedItem[],
  client: LlmClient,
  opts: DigestPipelineOptions,
  log: LogSink,
): Promise<boolean> {
  const top = items.filter((i) => (i.score ?? 0) > -0.5).slice(0, opts.llmScoreCandidates ?? 40)
  if (!top.length) return false
  const n = await scoreChunk(top, client, opts, log)
  return n >= Math.ceil(top.length / 2) // 覆盖过半才算数——只评出几条会误杀未评条目
}

/** P1 抓取后评分：本轮新条目本批去重 → 分块批量评分（无分跳过幂等）；返回评出条数。 */
export async function scoreNewItems(
  items: FeedItem[],
  client: LlmClient,
  opts: Pick<DigestPipelineOptions, 'llmTimeoutMs' | 'llmScoreCandidates' | 'llmMaxTokens' | 'signal' | 'prefs'>,
  log: LogSink,
): Promise<number> {
  const fresh = items.filter((i) => i.llmScore == null && !i.state.hidden)
  if (!fresh.length || (opts.llmScoreCandidates ?? 40) <= 0) return 0 // 0=关闭评分
  dedupeStories(fresh) // 本批 Jaccard 去重：dupOf 不送评分省 token；跨批同题日报时再并
  const scorable = fresh.filter((i) => !i.dupOf)
  const chunkSize = Math.max(1, opts.llmScoreCandidates ?? 40)
  const maxChunks = 50 // 防洪：单轮最多 50 块
  let scored = 0
  for (let i = 0; i < scorable.length && i / chunkSize < maxChunks; i += chunkSize) {
    if (opts.signal?.aborted) break
    scored += await scoreChunk(scorable.slice(i, i + chunkSize), client, opts, log)
  }
  if (scorable.length > maxChunks * chunkSize) log.warn(`scoreNewItems truncated: ${scorable.length} items > ${maxChunks} chunks`)
  return scored
}

/** P8 时段快报：高分条目按领域分组追加/覆盖 `## HH:mm 时段快报` 节（{day}-hourly.md）。 */
export async function appendHourlyBrief(opts: {
  items: FeedItem[]
  sourcesById: Map<string, { title: string }>
  day: string
  time: string // "HH:mm"
  minScore: number
  digestsDir: string
  log?: LogSink
}): Promise<number> {
  const log = opts.log || noopLog
  const scored = opts.items.filter((i) => !i.dupOf && !i.state.hidden && (i.llmScore ?? 0) >= opts.minScore)
  if (!scored.length) return 0
  const groups = new Map<string, FeedItem[]>()
  for (const it of [...scored].sort((a, b) => (b.llmScore ?? 0) - (a.llmScore ?? 0))) {
    const t = it.topic || '综合'
    groups.set(t, [...(groups.get(t) ?? []), it])
  }
  const lines = [`## ${opts.time} 时段快报`, '']
  for (const [topic, list] of groups) {
    lines.push(`### ${topic}`)
    for (const it of list) {
      const src = opts.sourcesById.get(it.sourceId)?.title ?? it.sourceId
      const meta = [`评分 ${it.llmScore}`, src, ...(it.tags ?? []).map((t) => `#${t}`)].join(' · ')
      lines.push(`- **${it.title}**  \n  ${meta}${it.llmReason ? ` — ${it.llmReason}` : ''}  \n  ${it.link || ''}`)
    }
    lines.push('')
  }
  const section = lines.join('\n').trimEnd() + '\n'
  const file = join(opts.digestsDir, `${opts.day}-hourly.md`)
  const head = `# 时段快报 · ${opts.day}\n\n`
  let body = ''
  await mkdir(opts.digestsDir, { recursive: true })
  try { body = await readFile(file, 'utf8') } catch { /* 新文件 */ }
  if (body.startsWith(head)) body = body.slice(head.length)
  const marker = `## ${opts.time} 时段快报`
  // 幂等：同刻已存在则替换该节（到下一个 ## 或文件尾），否则追加
  const idx = body.indexOf(marker)
  if (idx >= 0) {
    const rest = body.slice(idx + marker.length)
    const nextH = rest.indexOf('\n## ')
    body = body.slice(0, idx) + section + (nextH >= 0 ? rest.slice(nextH + 1) : '')
  } else {
    body = body + section
  }
  await writeFile(file, head + body, 'utf8')
  log.info(`hourlyBrief ${opts.time}: ${scored.length} items -> ${file}`)
  return scored.length
}

/** v2 同题合并：标题归一化后 token 重叠 >0.55 视为同一事件；合并到排序靠前的主条目，dupCount 计数。 */
function dedupeStories(items: FeedItem[]): FeedItem[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const toks = (s: string) => {
    // CJK/拉丁边界断开：'openai发布gpt-6模型' → 'openai 发布 gpt 6 模型'
    const n = norm(s)
      .replace(/([a-z0-9])([\u4e00-\u9fff])/g, '$1 $2')
      .replace(/([\u4e00-\u9fff])([a-z0-9])/g, '$1 $2')
    const set = new Set<string>()
    for (const w of n.split(' ').filter(Boolean)) {
      if (/[\u4e00-\u9fff]/.test(w)) // CJK 段只进字符 bigram（整词几乎不重复，混进来会稀释相似度）
        for (let i = 0; i + 1 < w.length; i++) set.add(w.slice(i, i + 2))
      else set.add(w) // 拉丁/数字词原样进（单字符保留——靠数字区分 News item 1/2）
    }
    return set
  }
  const out: FeedItem[] = []
  const tokSets: Array<Set<string>> = []
  for (const it of items) {
    const ts = toks(it.title)
    if (ts.size === 0) { out.push(it); tokSets.push(ts); continue }
    let hit = -1
    for (let j = 0; j < out.length; j++) {
      const inter = [...ts].filter((w) => tokSets[j].has(w)).length
      // 真 Jaccard（交/并）：合成标题 "News item 1" vs "News item 2" → 2/4=0.5 不合并；
      // 真实同题 "OpenAI releases GPT-6" vs "OpenAI releases GPT-6 model today" → 5/6≈0.83 合并
      if (inter / (ts.size + tokSets[j].size - inter) > 0.55) { hit = j; break }
    }
    if (hit >= 0) { out[hit].dupCount = (out[hit].dupCount || 0) + 1; it.dupOf = out[hit].id }
    else { out.push(it); tokSets.push(ts) }
  }
  return out
}

/** v2 LLM 聚类：标题不同的同事件条目（语义同题，Jaccard 抓不到）→ dupOf 合并；失败返回 false。 */
async function llmClusterItems(
  items: FeedItem[],
  client: LlmClient,
  opts: DigestPipelineOptions,
  log: LogSink,
): Promise<boolean> {
  const top = items.filter((i) => (i.score ?? 0) > -0.5).slice(0, opts.llmScoreCandidates ?? 40)
  if (top.length < 2) return false
  try {
    const text = await client.generateText({
      system: '把报道同一事件/同一主体的条目分组（措辞不同但同一件事）。只输出 JSON 数组的数组 [[序号,序号],[序号]]，无同题输出 []，不要解释。',
      prompt: top.map((it, idx) => `${idx + 1}. ${it.title}`).join('\n'),
      maxTokens: 800,
      signal: AbortSignal.any([AbortSignal.timeout(opts.llmTimeoutMs), ...(opts.signal ? [opts.signal] : [])]),
    })
    const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || 'null')
    if (!Array.isArray(arr)) return false
    for (const g of arr as unknown[]) {
      if (!Array.isArray(g)) continue
      const idxs = g.map(Number).filter((n) => n >= 1 && n <= top.length)
      if (idxs.length < 2) continue
      const keep = top[idxs[0] - 1] // 组内第一个（启发式序最靠前）为主条目
      for (const n of idxs.slice(1)) {
        const it = top[n - 1]
        if (it === keep) continue
        keep.dupCount = (keep.dupCount || 0) + 1 + (it.dupCount || 0)
        it.dupOf = keep.id
      }
    }
    return true
  } catch (e) {
    log.warn(`llmCluster failed, jaccard only: ${e instanceof Error ? e.message : e}`)
    return false
  }
}

/** v3 最终挑选：llmScore ?? 启发式 单键降序；阈值只管有分条目；perTopicLimit 软配额。 */
function pickFinal(items: FeedItem[], opts: DigestPipelineOptions): FeedItem[] {
  const minScore = opts.minLlmScore ?? 5
  // ingest 时一次写入的 llmScore 参与排序；无分条目启发式分(~0-1.2域)线性映射到 0-10 正常竞争（未评≠低分）
  const keyOf = (it: FeedItem) => it.llmScore ?? Math.min(10, Math.max(0, (it.score ?? 0) * 8))
  const ranked = [...items].sort((a, b) => (keyOf(b) - keyOf(a)) || (b.score ?? 0) - (a.score ?? 0))
  const picked: FeedItem[] = []
  const overflow: FeedItem[] = []
  const perTopic: Record<string, number> = {}
  for (const it of ranked) {
    if ((it.score ?? 0) <= -0.5) continue // 屏蔽/隐藏
    if (it.llmScore != null && it.llmScore < minScore) continue // 评过且未达标才过滤
    const topic = it.topic || '综合'
    if (opts.perTopicLimit > 0 && (perTopic[topic] || 0) >= opts.perTopicLimit) { overflow.push(it); continue }
    picked.push(it)
    perTopic[topic] = (perTopic[topic] || 0) + 1
    if (picked.length >= opts.digestItems) break
  }
  // 主题配额用完后仍不足 N：溢出项按序补齐（宁可满员不空缺——与 scoreAndSelect 原语义一致）
  for (const it of overflow) {
    if (picked.length >= opts.digestItems) break
    picked.push(it)
  }
  return picked
}

/** 逐条一句话摘要：并发受限、单条失败只写 aiSummaryError 不丢条目；summarize=false 的源跳过（用 feed 原摘要）。 */
async function itemSummaries(
  items: FeedItem[],
  sourcesById: ReadonlyMap<string, { title: string; summarize: boolean }>,
  client: LlmClient,
  opts: DigestPipelineOptions,
): Promise<void> {
  const targets = items.filter((i) => sourcesById.get(i.sourceId)?.summarize !== false).slice(0, opts.summaryMaxItems)
  const queue = [...targets]
  let done = 0
  const workers = Array.from({ length: Math.max(1, opts.summaryConcurrency) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      try {
        // v2：分类定制 + JSON 结构化块（bg/point/takeaway）；解析失败回退纯文本 aiSummary
        const catPrompt = opts.categoryPrompts?.[item.topic || ''] || DEFAULT_CAT_PROMPTS[item.topic || ''] || DEFAULT_CAT_PROMPTS['综合']
        const text = await client.generateText({
          system: `你是资深新闻编辑。针对这条新闻重写短标题并写三块，严格只输出 JSON {"title":"重写标题（≤15词/等价短句，去标题党，保留产品名与关键变化）","summary":"核心事实：变了什么、对谁（区分厂商宣称与已交付能力，1-2句）","background":"读懂这条需要的前提概念或前情（1句）","impact":"${catPrompt}（具体后果，一句话）"}，不要解释、不要代码块围栏。`,
          prompt: `标题：${item.title}\n来源：${sourcesById.get(item.sourceId)?.title ?? item.sourceId}\n分类：${item.topic || '综合'}\n摘要：${truncateCodePoints(item.summary || item.content || '', 500)}`,
          maxTokens: opts.llmMaxTokens,
          signal: AbortSignal.any([AbortSignal.timeout(opts.llmTimeoutMs), ...(opts.signal ? [opts.signal] : [])]),
        })
        const m = text.match(/\{[\s\S]*\}/)
        const j = m ? (JSON.parse(m[0]) as { title?: string; summary?: string; background?: string; impact?: string }) : null
        if (j && (j.summary || j.background || j.impact)) {
          if (j.title) item.aiTitle = String(j.title).slice(0, 80)
          item.aiBlocks = { summary: String(j.summary || ''), background: String(j.background || ''), impact: String(j.impact || '') }
          item.aiSummary = item.aiBlocks.summary // 列表行沿用 summary 段做一行摘要
        } else {
          const flat = text.trim()
          if (flat) item.aiSummary = truncateCodePoints(flat, opts.summaryMaxLength * 4)
          else item.aiSummaryError = 'empty response'
        }
      } catch (e) {
        item.aiSummaryError = e instanceof Error ? e.message : String(e)
      }
      done += 1
      opts.onItemDone?.(done, targets.length)
    }
  })
  await Promise.all(workers)
}

/** 生成并落盘当日日报；返回 DigestDocument（含 degraded/note 元数据）。 */
export async function runDailyDigest(opts: DigestPipelineOptions): Promise<DigestDocument> {
  const log = opts.log || noopLog
  const startMs = Date.now()
  const now = opts.now ?? new Date()
  const day = opts.day || zonedDayKey(now, opts.timezone || undefined)
  const sources = effectiveSources(opts.configSources, opts.store)
  const sourcesById = new Map(sources.map((s) => [s.id, s]))

  // 候选池：今日未推过 + 未隐藏；candidateHours>0 时限近 N 小时
  const cutoff = (opts.candidateHours ?? 0) > 0 ? now.getTime() - opts.candidateHours! * 3600e3 : 0
  const subs = opts.subscribedTopics
  const candidates = opts.store.items.filter((i) =>
    (opts.force || i.digestedDay !== day) && !i.state.hidden
    && (!cutoff || new Date(i.fetchedAt).getTime() >= cutoff)
    && (!subs?.length || subs.includes(i.topic || '综合')), // P5 订阅分类：未订阅不进池
  )
  // v2：启发式全量粗排 → 同题合并 → LLM 评分（可关/失败回退）→ 阈值+perTopic 挑选
  for (const i of candidates) { i.dupCount = undefined; i.dupOf = undefined; i.aiBlocks = undefined } // 清上轮产物；llmScore/tags 是 ingest 一次性属性不清
  const allScored = scoreAndSelect(candidates, sourcesById, Math.max(candidates.length, 1), {
    prefs: opts.prefs,
    digestDay: day,
    now,
    perTopicLimit: 0, // 上限在 pickFinal 统一应用（LLM 评分后才有意义）
    penaltyWindowDays: opts.penaltyWindowDays,
  })
  let merged = (opts.dedupeStories ?? true) ? dedupeStories(allScored) : allScored
  if ((opts.dedupeStories ?? true) && opts.llmEnabled && opts.llmClient) {
    // LLM 语义聚类（措辞不同的同事件）；失败仅 Jaccard
    await llmClusterItems(merged, opts.llmClient, opts, log)
    merged = merged.filter((i) => !i.dupOf)
  }
  // P3 补评兜底：无分候选（存量/评分失败批次）补评一次，写回持久化
  if ((opts.rescoreMissing ?? true) && opts.llmEnabled && opts.llmClient && (opts.llmScoreCandidates ?? 40) > 0) {
    const unscored = merged.filter((i) => i.llmScore == null && (i.score ?? 0) > -0.5)
    if (unscored.length) await llmScoreItems(unscored, opts.llmClient, opts, log)
  }
  const picked = pickFinal(merged, opts)

  // 逐条摘要（仅当有可用 LLM）；summarize=false 的源在 itemSummaries 内跳过
  if (opts.summaryEnabled && opts.llmEnabled && opts.llmClient) {
    await itemSummaries(picked, sourcesById, opts.llmClient, opts)
  }
  // 英文条目生成中英对照译文（翻译模型/缺省跟随摘要模型）
  if (opts.llmEnabled && opts.translateClient) {
    await translateItems(picked, opts.translateClient, opts)
  }

  // 整体总结：>25 条走两段式——分块各总结→合并块总结再压一遍（单次调用压 100+ 条必然丢细节）
  const summaryItems = picked.map((i) => toSummarizable(i, sourcesById.get(i.sourceId)?.title ?? i.sourceId))
  opts.onItemDone?.(1, 1, 'finishing')
  const sumReq = (items: typeof summaryItems, maxLength: number) => ({
    items, language: opts.language, mode: 'batch' as const, maxLength,
    maxTokens: opts.llmMaxTokens,
    signal: AbortSignal.any([AbortSignal.timeout(opts.llmTimeoutMs), ...(opts.signal ? [opts.signal] : [])]),
  })
  const llmOn = opts.llmEnabled && !!opts.llmClient
  // P6：按领域分组做 chunk——块摘要即领域速览，合并后仍得今日重点
  const byTopic = new Map<string, typeof summaryItems>()
  for (const it of summaryItems) {
    const t = it.topic || '综合'
    byTopic.set(t, [...(byTopic.get(t) ?? []), it])
  }
  const topicChunks: Array<{ topic: string; items: typeof summaryItems }> = []
  for (const [topic, list] of byTopic) {
    for (let i = 0; i < list.length; i += 25) topicChunks.push({ topic, items: list.slice(i, i + 25) })
  }
  const domainSummaries: Array<{ topic: string; text: string; count: number }> = []
  const sum = !llmOn
    ? await summarize(sumReq(summaryItems, opts.digestMaxLength), opts.llmClient, llmOn)
    : await (async () => {
        const chunkMax = Math.max(300, Math.ceil(opts.digestMaxLength / Math.max(1, topicChunks.length)))
        const parts = await Promise.all(topicChunks.map((c) => summarize(sumReq(c.items, chunkMax), opts.llmClient, llmOn)))
        // 同主题多块合并为一行速览（首块摘要+总条数）
        const agg = new Map<string, { text: string; count: number }>()
        for (const [i, c] of topicChunks.entries()) {
          const e = agg.get(c.topic)
          if (e) e.count += c.items.length
          else agg.set(c.topic, { text: parts[i].text.slice(0, 300), count: c.items.length })
        }
        for (const [topic, e] of agg) domainSummaries.push({ topic, text: e.text, count: e.count })
        if (topicChunks.length === 1) return parts[0]
        const merged = parts.map((p, i) => ({ title: `${topicChunks[i].topic}板块摘要`, sourceTitle: '', publishedAt: '', link: '', summary: p.text, content: '', topic: '', reasons: [] }))
        return summarize(sumReq(merged, opts.digestMaxLength), opts.llmClient, llmOn)
      })()

  // 源状态行：失败/冷却的源点名
  const failed = sources.filter((s) => s.health.lastError)
  const cooling = sources.filter((s) => s.health.cooldownUntil && new Date(s.health.cooldownUntil).getTime() > now.getTime()).length
  const statusLines = [`采集源状态：${sources.filter((s) => s.enabled).length}/${sources.length} 源 · ${opts.store.items.length} 条 · ${failed.length ? `${failed.length} 源异常${cooling ? `（${cooling} 冷却中）` : ''}` : '健康'}`]

  const degraded = sum.source !== 'llm'
  const note = degraded ? `summary degraded: ${sum.error ?? 'llm unavailable'}` : ''

  // 幂等保护：非 force 重跑若选出 0 条且当日已有日报，不覆盖旧文件
  const file = join(opts.digestsDir, digestFileName(day, opts.language))
  if (picked.length === 0 && !opts.force) {
    try {
      await access(file)
      const markdown = await readFile(file, 'utf8')
      // 同步 meta 防重启后 catch-up 反复白跑（digest-pipeline.ts:154 早退）
      opts.store.meta.lastDigestDay = day
      opts.store.meta.lastDigestAt = now.toISOString()
      await opts.store.save()
      log.warn(`digest ${day}: 0 candidates; kept existing digest file`)
      return { title: `RSS 简报 · ${day}`, date: day, language: opts.language, markdown, itemCount: 0, itemIds: [], summarySource: sum.source, degraded: true, note: 'no candidates; kept existing digest' }
    } catch { /* no existing file — fall through and write empty digest */ }
  }

  const elapsedMs = Date.now() - startMs
  const markdown = renderDigest({
    durationMs: elapsedMs,
    generatedAt: now,
    date: day,
    language: opts.language,
    sourceTitles: new Map(sources.map((s) => [s.id, s.title])),
    items: picked,
    summaryText: sum.text,
    includeItemLinks: true,
    sourcesStatus: statusLines,
    degradedNote: degraded ? note.replace('summary degraded: ', '') : undefined,
    domainSummaries,
  })

  await mkdir(opts.digestsDir, { recursive: true })
  await writeFile(file, markdown, 'utf8')

  opts.store.markDigested([...picked.map((i) => i.id), ...allScored.filter((i) => i.dupOf).map((i) => i.id)], day)
  opts.store.meta.lastDigestDay = day
  opts.store.meta.lastDigestAt = now.toISOString()
  await opts.store.save()

  // digests/index.json：历史日报索引（§4 契约，供 API/外部列历史）
  const indexFile = join(opts.digestsDir, 'index.json')
  let index: Array<{ date: string; items: number; degraded: boolean; note: string }> = []
  try { index = JSON.parse(await readFile(indexFile, 'utf8')) } catch { /* first run */ }
  const entry = { date: day, items: picked.length, degraded, note }
  const i = index.findIndex((e) => e.date === day)
  if (i >= 0) index[i] = entry
  else index.push(entry)
  index.sort((a, b) => b.date.localeCompare(a.date))
  await writeFile(indexFile, JSON.stringify(index.slice(0, 90), null, 2), 'utf8')

  log.info(`digest ${day}: ${picked.length} items, summary=${sum.source}${note ? ` (${note})` : ''} -> ${file}`)

  return {
    title: `RSS 简报 · ${day}`,
    date: day,
    language: opts.language,
    markdown,
    itemCount: picked.length,
    itemIds: picked.map((i) => i.id),
    summarySource: sum.source,
    degraded,
    note,
    tokens: (() => { const u = (opts.llmClient as { usage?: { inputTokens: number; outputTokens: number } } | undefined)?.usage; return u && (u.inputTokens + u.outputTokens) > 0 ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens } : undefined })(),
  }
}
