/**
 * AI 专题管线：候选筛选 → 两级去重 → 分批小结 → 合并成文 → 起名 → [N] 引用解析 → 落盘+索引。
 *
 * 与日报同铁律：任意一次 LLM 失败只降级该处，专题永远产出（抽取式兜底）。
 * 纯模块：node:fs/node:path 之外无宿主依赖；LLM 经注入的 LlmClient。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { FeedItem, LogSink } from './core/types.js'
import { noopLog } from './core/types.js'
import { leadKey, stripHtml, truncateCodePoints } from './core/parser.js'
import { zonedDayBounds } from './core/time.js'
import { dedupeStories, zhTitleOf } from './digest-pipeline.js'
import type { LlmClient } from './summarizer.js'

// ---------------------------------------------------------------- 参数与元数据

export interface TopicParams {
  keywords: string[]
  /** YYYY-MM-DD 本地日（含当日全天）；空=不限 */
  from: string
  to: string
  /** 空数组=全部源 */
  sourceIds: string[]
  /** 专题重点/方向（拼进各批与合并 prompt） */
  focus: string
  /** 0=不限；白名单 3/5/7/8 */
  minScore: number
  /** 入文条数上限；白名单 50/100/200/500 */
  maxItems: number
}

export interface TopicMeta {
  id: string
  title: string
  keywords: string[]
  from: string
  to: string
  sourceIds: string[]
  focus: string
  minScore: number
  maxItems: number
  createdAt: string
  updatedAt: string
  /** 去重前命中（关键词并集按 id 去重后） */
  hitCount: number
  /** 两级去重后候选数 */
  dedupCount: number
  /** 入文条数（编号 1..itemCount） */
  itemCount: number
  /** 正文实际引用的条目数 */
  usedCount: number
  durationMs: number
  degraded: boolean
  excerpt: string
  status: 'generating' | 'queued' | 'done' | 'error'
  error?: string
}

const MAX_ITEMS_WHITELIST = [50, 100, 200, 500]
const MIN_SCORE_WHITELIST = [0, 3, 5, 7, 8]
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** API 入参归一化；缺省补默认，白名单外值返回 400 文案。 */
export function normalizeTopicParams(body: unknown): { ok: true; params: TopicParams } | { ok: false; error: string } {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const keywords = [...new Set(
    (Array.isArray(b.keywords) ? b.keywords : [])
      .map((k) => String(k).trim()).filter((k) => k.length > 0 && k.length <= 60),
  )].slice(0, 10)
  if (!keywords.length) return { ok: false, error: 'keywords 至少需要一个非空关键词' }
  const day = (v: unknown) => (typeof v === 'string' && DAY_RE.test(v) ? v : '')
  let from = day(b.from), to = day(b.to)
  if (from && to && from > to) [from, to] = [to, from] // 起止写反了：交换而不是拒绝
  const sourceIds = [...new Set(
    (Array.isArray(b.sourceIds) ? b.sourceIds : []).map((s) => String(s).trim()).filter(Boolean),
  )].slice(0, 200)
  const focus = typeof b.focus === 'string' ? b.focus.trim().slice(0, 500) : ''
  if (b.minScore !== undefined && !(typeof b.minScore === 'number' && MIN_SCORE_WHITELIST.includes(b.minScore))) {
    return { ok: false, error: `minScore 取值：${MIN_SCORE_WHITELIST.join('/')}` }
  }
  if (b.maxItems !== undefined && !(typeof b.maxItems === 'number' && MAX_ITEMS_WHITELIST.includes(b.maxItems))) {
    return { ok: false, error: `maxItems 取值：${MAX_ITEMS_WHITELIST.join('/')}` }
  }
  return {
    ok: true,
    params: {
      keywords, from, to, sourceIds, focus,
      minScore: typeof b.minScore === 'number' ? b.minScore : 0,
      maxItems: typeof b.maxItems === 'number' ? b.maxItems : 100,
    },
  }
}

export function newTopicId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// ---------------------------------------------------------------- 候选管线（预览与生成共用，纯查询不调 LLM）

/** 专题候选需要的最小 store 面（SqliteStore.queryItems 的 subset） */
export interface TopicItemStore {
  queryItems(opts: {
    q?: string
    sources?: string[]
    publishedAfter?: string
    publishedBefore?: string
    minScore?: number
    sort?: 'published' | 'fetched'
    page?: number
    pageSize?: number
  }): { total: number; items: FeedItem[] }
}

/** 展示分口径：llmScore 优先，缺省启发式分换算（与 pickFinal/SQL 下推同式） */
export const topicKeyOf = (i: FeedItem): number => i.llmScore ?? Math.min(10, Math.max(0, (i.score ?? 0) * 8))

export interface TopicCandidates {
  /** 关键词并集（按 id 去重后）命中数 */
  hitCount: number
  /** 两级去重后候选数 */
  dedupCount: number
  /** 最终入文（cap 后），顺序即全局编号 1..N */
  items: FeedItem[]
}

export function queryTopicCandidates(store: TopicItemStore, params: TopicParams, timezone?: string): TopicCandidates {
  const cap = Math.max(1, params.maxItems || 100)
  const bFrom = params.from ? zonedDayBounds(params.from, timezone).after : undefined
  const bTo = params.to ? zonedDayBounds(params.to, timezone).before : undefined
  const sources = params.sourceIds.length ? params.sourceIds : undefined
  const minScore = params.minScore > 0 ? params.minScore : undefined
  const byId = new Map<string, FeedItem>()
  for (const kw of params.keywords) {
    const r = store.queryItems({
      q: kw, sources, publishedAfter: bFrom, publishedBefore: bTo, minScore,
      sort: 'published', pageSize: cap,
    })
    for (const it of r.items) if (!byId.has(it.id)) byId.set(it.id, it)
  }
  const hitCount = byId.size
  // 去重①标题同题：dedupeStories 按数组序合并到靠前主条目——先按评分降序排，保最高分为主条目
  const titleDeduped = dedupeStories([...byId.values()].sort((a, b) => topicKeyOf(b) - topicKeyOf(a)))
    .filter((i) => !i.dupOf)
  // 去重②内容同文：归一化 summary+content 分组，留评分最高者，dupCount 累计
  const kept: FeedItem[] = []
  const seen = new Map<string, FeedItem>()
  for (const it of titleDeduped) {
    const key = leadKey(`${it.summary || ''} ${it.content || ''}`)
    if (key.length >= 24) { // 归一化后过短=无判别力，不并入
      const prev = seen.get(key)
      if (prev) {
        if (topicKeyOf(it) > topicKeyOf(prev)) {
          it.dupCount = (it.dupCount || 0) + (prev.dupCount || 0) + 1
          seen.set(key, it)
          kept[kept.indexOf(prev)] = it
        } else {
          prev.dupCount = (prev.dupCount || 0) + (it.dupCount || 0) + 1
        }
        continue
      }
      seen.set(key, it)
    }
    kept.push(it)
  }
  kept.sort((a, b) => topicKeyOf(b) - topicKeyOf(a))
  return { hitCount, dedupCount: kept.length, items: kept.slice(0, cap) }
}

// ---------------------------------------------------------------- [N] 引用协议与渲染

const escapeLinkText = (t: string) => t.replace(/[[\]()\n\r]/g, ' ').replace(/\s+/g, ' ').trim()
const safeLinkUrl = (u: string) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim().replace(/[()\s]/g, '') : '')

/** 正文中 [N] 解析：合法→紧凑编号链接 [N](url) 并入 usedSet（参考区同编号对应）；越界/畸形→整个标记丢弃（不猜）。
 * 注意不替换成 [标题](url)：一句多引时正文会被长标题+长链接砸烂——编号即引用，参考区才是完整清单。 */
export function parseTopicCitations(text: string, items: FeedItem[]): { text: string; used: FeedItem[] } {
  const usedNums = new Set<number>()
  const out = text.replace(/\[(\d{1,3})\]/g, (_m, g: string) => {
    const n = Number(g)
    if (!Number.isInteger(n) || n < 1 || n > items.length) return ''
    usedNums.add(n)
    const url = safeLinkUrl(items[n - 1].link)
    return url ? `[${n}](${url})` : `[${n}]`
  })
  const used = [...usedNums].sort((a, b) => a - b).map((n) => items[n - 1])
  return { text: out, used }
}

/** meta.excerpt：取「概述」节纯文本 ~120 字；无该节取正文开头 */
export function topicExcerpt(body: string): string {
  const m = /##\s*概述[^\n]*\n+([\s\S]*?)(?=\n\s*##|$)/.exec(body)
  const raw = (m?.[1] || body)
    .replace(/\[\d{1,3}\]\([^)]*\)/g, '') // 数字引用标在摘要里无意义（参考区不在摘要），整个去掉
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*`-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return truncateCodePoints(raw, 120)
}

/** LLM 标题消毒：取首行、去 markdown/标点壳、截断；空→''（调用方回退关键词） */
export function sanitizeTopicTitle(raw: string): string {
  const line = String(raw || '').split('\n').map((s) => s.trim()).find(Boolean) || ''
  const t = line.replace(/^#+\s*/, '').replace(/[*`_~「」『』《》"“”'‘’]/g, '').replace(/[\s.。,，、:：;；!！?？]+$/, '').trim()
  return truncateCodePoints(t, 30).trim()
}

export interface TopicRenderInput {
  title: string
  keywords: string[]
  from: string
  to: string
  focus: string
  hitCount: number
  dedupCount: number
  itemCount: number
  usedItems: FeedItem[]
  /** 全部入文（usedItems 编号引用用） */
  items: FeedItem[]
  sourcesById: Map<string, { title: string }>
  body: string
  createdAt: string
  durationMs: number
  degraded: boolean
}

/** 超长段落重排：模型常把整节/整条写成一行（实测 1300+ 字一段、1100+ 字单条 bullet），按中文句读边界切成 ≤420 字。
 * 正文行切段（段间空行）；超长 - 列表项拆成多条 bullet（条间不换空行）。切点要求行内 ** 与 * 标记成对闭合，不切断行内标记。 */
export function reflowTopicBody(body: string): string {
  const marksEven = (s: string) => (s.match(/\*\*/g) || []).length % 2 === 0 && (s.match(/(?<!\*)\*(?!\*)/g) || []).length % 2 === 0
  const splitAt = (line: string): string[] => {
    if (line.length <= 420) return [line]
    const cuts: number[] = []
    for (let i = 0; i < line.length; i++) {
      if ('。！？；'.includes(line[i]) && marksEven(line.slice(0, i + 1))) cuts.push(i + 1)
    }
    const out: string[] = []
    let start = 0
    while (line.length - start > 420) {
      const cand = cuts.filter((c) => c - start > 60 && c - start <= 420)
      let cut = cand.length ? cand[cand.length - 1] : cuts.find((c) => c - start > 60 && c - start <= 560)
      if (!cut || cut <= start) break
      const citeTail = line.slice(cut).match(/^(\s*\[\d+\](?:\([^()\s]*\))?\s*[、，,]?\s*)+/) // 句末引用簇跟随前句——不许从簇中间切开让引用脱落成独立段（兼容 [n] 与已解析的 [n](url)）
      if (citeTail && citeTail[0].length <= 300 && cut + citeTail[0].length - start <= 560) cut += citeTail[0].length
      out.push(line.slice(start, cut)); start = cut
    }
    out.push(line.slice(start))
    return out
  }
  return body.split('\n').map((l) => {
    const t = l.trim()
    if (!t || t.startsWith('#') || t.startsWith('>') || /^\d+\.\s/.test(t)) return l
    if (t.startsWith('- ')) return splitAt(l.slice(l.indexOf('- ') + 2)).map((p) => `- ${p}`).join('\n')
    return splitAt(l).join('\n\n')
  }).join('\n')
}

/** 程序渲染首尾：H1+meta 引用块+参考新闻+页脚；LLM 只写中间 sections。 */
export function renderTopic(o: TopicRenderInput): string {
  const secs = Math.round(o.durationMs / 1000)
  const range = `${o.from || '最早'} ~ ${o.to || '最新'}`
  const srcCount = new Set(o.items.map((i) => i.sourceId)).size // 入文条目实际覆盖的源数
  const meta =
    `> ${o.itemCount} 条入文（命中 ${o.hitCount} · 去重后 ${o.dedupCount}）`
    + ` · ${srcCount} 源 · ${range} · 关键词 ${o.keywords.join('、')}`
    + (o.focus ? ` · 重点：${o.focus.slice(0, 40)}` : '')
    + ` · 生成于 ${o.createdAt.slice(0, 16).replace('T', ' ')} · 耗时 ${secs}s`
    + (o.degraded ? ' · ⚠ 模型不可用，降级产出' : '')
    + (o.itemCount > 0 && o.usedItems.length === 0 ? ' · 未捕获引用' : '')
  const refs = o.usedItems.length
    ? `## 参考新闻（${o.usedItems.length} 条）\n\n` + o.usedItems.map((it) => {
      const n = o.items.indexOf(it) + 1
      const src = o.sourcesById.get(it.sourceId)?.title || it.topic || ''
      const date = (it.publishedAt || it.fetchedAt || '').slice(0, 10)
      const title = escapeLinkText(zhTitleOf(it)) || it.title
      const url = safeLinkUrl(it.link)
      const score = topicKeyOf(it)
      const dup = it.dupCount ? ` · 同题 ${it.dupCount + 1} 家报道` : ''
      return `${n}. ${url ? `[${title}](${url})` : title}${src ? ` · ${src}` : ''}${date ? ` · ${date}` : ''}${score ? ` · 评分 ${score}` : ''}${dup}`
    }).join('\n')
    : ''
  return `# ${o.title}\n\n${meta}\n\n${o.body.trim()}\n\n${refs ? `${refs}\n\n` : ''}---\nGenerated by dsh-rss-news-daily\n`
}

// ---------------------------------------------------------------- 存储：digests/topics/<id>.md + index.json（tmp+rename 原子写）

export function topicsDirOf(digestsDir: string): string {
  return join(digestsDir, 'topics')
}

const INDEX_FILE = 'index.json'

export async function readTopicsIndex(digestsDir: string): Promise<TopicMeta[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(topicsDirOf(digestsDir), INDEX_FILE), 'utf8'))
    const list = Array.isArray(raw)
      ? raw
      : (raw && typeof raw === 'object' && Array.isArray((raw as { topics?: unknown }).topics)
        ? (raw as { topics: unknown[] }).topics
        : [])
    return list.filter((m): m is TopicMeta =>
      typeof m === 'object' && m !== null && typeof (m as TopicMeta).id === 'string') as TopicMeta[]
  } catch {
    return [] // 缺目录/坏文件都按空索引
  }
}

export async function writeTopicsIndex(digestsDir: string, topics: TopicMeta[]): Promise<void> {
  const dir = topicsDirOf(digestsDir)
  await mkdir(dir, { recursive: true })
  const file = join(dir, INDEX_FILE)
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify({ version: 1, topics }, null, 1), 'utf8')
  await rename(tmp, file)
}

export async function upsertTopicMeta(digestsDir: string, meta: TopicMeta): Promise<void> {
  const list = await readTopicsIndex(digestsDir)
  const i = list.findIndex((m) => m.id === meta.id)
  if (i >= 0) list[i] = meta
  else list.unshift(meta) // 新专题排最前
  await writeTopicsIndex(digestsDir, list)
}

/** 列表读取：activeId 之外的 generating、queuedIds 之外的 queued 一律懒修复为 error（进程重启中断；队列是内存态，重启即丢） */
export async function listTopics(digestsDir: string, opts?: { activeId?: string; queuedIds?: string[] }): Promise<TopicMeta[]> {
  const list = await readTopicsIndex(digestsDir)
  let dirty = false
  for (const m of list) {
    if (m.status === 'generating' && m.id !== opts?.activeId) {
      m.status = 'error'
      m.error = '进程重启中断'
      m.updatedAt = new Date().toISOString()
      dirty = true
    } else if (m.status === 'queued' && !opts?.queuedIds?.includes(m.id)) {
      m.status = 'error'
      m.error = '排队被进程重启中断'
      m.updatedAt = new Date().toISOString()
      dirty = true
    }
  }
  if (dirty) await writeTopicsIndex(digestsDir, list).catch(() => {})
  return list
}

export async function deleteTopic(digestsDir: string, id: string): Promise<boolean> {
  const list = await readTopicsIndex(digestsDir)
  const i = list.findIndex((m) => m.id === id)
  if (i < 0) return false
  list.splice(i, 1)
  await writeTopicsIndex(digestsDir, list)
  await rm(join(topicsDirOf(digestsDir), `${id}.md`), { force: true })
  return true
}

/** 导出文件名消毒：去路径分隔/控制符/markdown 壳，60 字截断 */
export function safeFileStem(s: string): string {
  const t = String(s || '').replace(/[\\/:*?"<>|\r\n\t#*`'"]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  return t || 'topic'
}

export async function exportTopic(digestsDir: string, id: string, dir: string): Promise<string> {
  const md = await readFile(join(topicsDirOf(digestsDir), `${id}.md`), 'utf8')
  const meta = (await readTopicsIndex(digestsDir)).find((m) => m.id === id)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${safeFileStem(meta?.title || id)}-${id}.md`)
  await writeFile(file, md, 'utf8')
  return file
}

// ---------------------------------------------------------------- LLM 生成管线

const BATCH = 25
const PER_ITEM_CHARS = 300

const TOPIC_BATCH_SYSTEM = '你是资深新闻编辑。基于给定的新闻条目（带全局编号 [N]），提炼其中与本专题相关的事实要点。'
  + '要求：每条要点一行（- 开头），涉及某条新闻时在句尾保留其编号标记（形如 [3]）；'
  + '同一事件只保留一行；只输出要点列表，不要标题、不要解释、不要寒暄。'

const TOPIC_MERGE_SYSTEM = '你是资深行业分析师。把输入的新闻素材整理成一份中文专题报告正文（Markdown）。'
  + '按以下节标题输出（## 二级标题，标题文字严格一致）：\n'
  + '## 概述 —— 一段执行摘要：发生了什么、主线、关键玩家\n'
  + '## 背景 —— 为什么值得关注、相关上下文与此前事件\n'
  + '## 发展脉络 —— 按时间线列出关键节点（节点带日期）\n'
  + '## 要点分析 —— 分子主题/影响面展开深入分析\n'
  + '以下四节只在素材足够支撑时输出，否则整节（含标题）省略：\n'
  + '## 影响评估 —— 受影响方与市场/行业含义\n'
  + '## 分歧与争议 —— 相互矛盾的报道或对立立场\n'
  + '## 关键数据 —— 可提取的数字事实（金额、份额、数量等）\n'
  + '## 展望与关注点 —— 后续值得跟踪的信号、里程碑、待解问题\n'
  + '硬性要求：素材条目/要点带编号标记，引用某条素材时在句尾保留其编号标记（形如 [3]）；'
  + '每个 ## 节正文分 2~4 个自然段，段与段之间空一行——按语义转折分段，不要把整节写成一整行；'
  + '不要输出参考新闻清单（程序自动追加）；不要寒暄、不要编造素材中没有的事实。'

const TOPIC_TITLE_SYSTEM = '为给出的专题报告正文起一个标题：不超过15个汉字的名词性短语，不带标点、书名号与引号。只输出标题本身一行。'

function numberedLine(it: FeedItem, n: number, sourcesById: Map<string, { title: string }>): string {
  const date = (it.publishedAt || it.fetchedAt || '').slice(0, 10)
  const src = sourcesById.get(it.sourceId)?.title || it.topic || ''
  const title = zhTitleOf(it).replace(/\s+/g, ' ').trim() || it.title // 标题压空白：防换行破坏编号行
  const lead = truncateCodePoints(stripHtml(it.summary || it.content || ''), PER_ITEM_CHARS).replace(/\s+/g, ' ').trim()
  return `[${n}] 「${title}」（${src} · ${date}）\n    ${lead || title}`
}

function batchNoteFallback(batch: FeedItem[], startIdx: number, sourcesById: Map<string, { title: string }>): string {
  return batch.map((it, j) => `- ${(it.publishedAt || it.fetchedAt || '').slice(5, 10)} ${zhTitleOf(it)}`
    + `${sourcesById.get(it.sourceId)?.title ? `（${sourcesById.get(it.sourceId)!.title}）` : ''} [${startIdx + j + 1}]`).join('\n')
}

/** 抽取式降级：固定四节（统计/上下文/按日脉络/top 要点），永远产出 */
function extractiveSections(items: FeedItem[], params: TopicParams, sourcesById: Map<string, { title: string }>): string {
  const srcs = new Set(items.map((i) => i.sourceId)).size
  const days = [...new Set(items.map((i) => (i.publishedAt || i.fetchedAt || '').slice(0, 10)).filter(Boolean))].sort()
  const overview = `本专题围绕关键词 ${params.keywords.join('、')}，`
    + `${params.from || '最早'} ~ ${params.to || '最新'} 范围内共入文 ${items.length} 条，来自 ${srcs} 个订阅源，`
    + `时间覆盖 ${days[0] || '?'} 至 ${days[days.length - 1] || '?'}。（模型不可用，以下为抽取式整理）`
  const background = `该专题由用户指定关键词与专题重点生成${params.focus ? `：${params.focus}` : '。'}`
    + `语料为已采集新闻库内匹配条目，按评分取前 ${items.length} 条入文。`
  const byDay = new Map<string, FeedItem[]>()
  for (const it of items) {
    const d = (it.publishedAt || it.fetchedAt || '').slice(0, 10) || '未知日期'
    const g = byDay.get(d) ?? []
    g.push(it); byDay.set(d, g)
  }
  const linkOf = (it: FeedItem): string => { // 降级正文直接把标题渲成链接——不走 [N] 标记（避免解析后「标题 [标题](url)」双份）
    const t = escapeLinkText(zhTitleOf(it).replace(/\s+/g, ' ')) || '无标题'
    const u = safeLinkUrl(it.link)
    return u ? `[${t}](${u})` : t
  }
  const timeline = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, list]) =>
    `- **${d}** ${list.map((it) => linkOf(it)).join('；')}`).join('\n')
  const top = items.slice(0, 12).map((it) =>
    `- ${linkOf(it)}（${sourcesById.get(it.sourceId)?.title || it.topic} · 评分 ${topicKeyOf(it)}）`).join('\n')
  return `## 概述\n\n${overview}\n\n## 背景\n\n${background}\n\n## 发展脉络\n\n${timeline || '- 无条目'}\n\n## 要点分析\n\n${top || '- 无条目'}`
}

export interface TopicPipelineOptions {
  store: TopicItemStore
  params: TopicParams
  /** 已落盘的 generating 元数据（id/createdAt 已定）；本函数就地更新到 done */
  meta: TopicMeta
  llmClient?: LlmClient
  llmEnabled: boolean
  /** 批小结 worker 数（实际并发受全局信号量约束） */
  summaryConcurrency: number
  llmTimeoutMs: number
  llmMaxTokens: number
  /** 外部取消信号（停止按钮/进程恢复） */
  signal?: AbortSignal
  sourcesById: Map<string, { title: string }>
  digestsDir: string
  timezone?: string
  log?: LogSink
  /** done/total=已完成批数；stage: candidates|chunks|finishing */
  onProgress?: (done: number, total: number, stage: string) => void
}

export async function runTopicPipeline(opts: TopicPipelineOptions): Promise<TopicMeta> {
  const log = opts.log ?? noopLog
  const t0 = Date.now()
  const meta = opts.meta
  const params = opts.params
  const signal = opts.signal
  const abortErr = () => Object.assign(new Error('手动停止'), { aborted: true })

  const { hitCount, dedupCount, items } = queryTopicCandidates(opts.store, params, opts.timezone)
  meta.hitCount = hitCount
  meta.dedupCount = dedupCount
  meta.itemCount = items.length
  const batches: FeedItem[][] = []
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH))
  const total = Math.max(1, batches.length)
  opts.onProgress?.(0, total, 'chunks')
  if (signal?.aborted) throw abortErr()

  const llmOk = opts.llmEnabled && !!opts.llmClient
  let body = ''

  if (items.length === 0) {
    body = '## 概述\n\n当前筛选条件下未命中任何新闻条目——换个关键词或放宽时间/评分范围再试。'
    meta.degraded = false
  } else if (!llmOk) {
    body = extractiveSections(items, params, opts.sourcesById)
    meta.degraded = true
  } else {
    try {
      let material: string
      let materialKind: 'items' | 'notes'
      if (batches.length <= 1) {
        // ≤1 批直通合并契约：输入编号条目而非批小结（输出节契约一致）
        material = items.map((it, i) => numberedLine(it, i + 1, opts.sourcesById)).join('\n')
        materialKind = 'items'
      } else {
        const notes = new Array<string>(batches.length).fill('')
        let cursor = 0
        let done = 0
        const workers = Array.from(
          { length: Math.max(1, Math.min(opts.summaryConcurrency, batches.length)) },
          async () => {
            for (;;) {
              if (signal?.aborted) return
              const i = cursor++
              if (i >= batches.length) return
              try {
                const text = await opts.llmClient!.generateText({
                  system: TOPIC_BATCH_SYSTEM,
                  prompt: `专题关键词：${params.keywords.join('、')}${params.focus ? `；专题重点：${params.focus}` : ''}\n条目：\n`
                    + batches[i].map((it, j) => numberedLine(it, i * BATCH + j + 1, opts.sourcesById)).join('\n'),
                  maxTokens: opts.llmMaxTokens,
                  signal,
                  timeoutMs: opts.llmTimeoutMs,
                  purpose: 'topic-chunk',
                })
                notes[i] = text.trim() || batchNoteFallback(batches[i], i * BATCH, opts.sourcesById)
              } catch (e) {
                if (signal?.aborted) return
                log.warn(`topic batch ${i + 1}/${batches.length} failed: ${e instanceof Error ? e.message : e}`)
                notes[i] = batchNoteFallback(batches[i], i * BATCH, opts.sourcesById)
              }
              opts.onProgress?.(++done, total, 'chunks')
            }
          },
        )
        await Promise.all(workers)
        if (signal?.aborted) throw abortErr()
        material = notes.map((n, i) => `### 批 ${i + 1}\n${n}`).join('\n\n')
        materialKind = 'notes'
      }
      opts.onProgress?.(batches.length > 1 ? total : 0, total, 'finishing')
      const merged = (await opts.llmClient!.generateText({
        system: TOPIC_MERGE_SYSTEM,
        prompt: `专题关键词：${params.keywords.join('、')}；时间范围：${params.from || '最早'} ~ ${params.to || '最新'}`
          + `${params.focus ? `；专题重点：${params.focus}` : ''}\n`
          + `${materialKind === 'items' ? '候选新闻条目（编号 1..N，供全文引用）' : '各批要点小结（条目编号跨批连续，供全文引用）'}：\n\n${material}`,
        maxTokens: Math.min(32768, opts.llmMaxTokens * 2), // 合并写整篇报告预算≥批小结的 2 倍；推理模型思考另占大头，不能再被 min(4096) 反钳
        signal,
        timeoutMs: opts.llmTimeoutMs,
        purpose: 'topic-merge',
      })).trim()
      if (!merged) throw new Error('empty model output')
      body = merged
      meta.degraded = false
    } catch (e) {
      if (signal?.aborted) throw abortErr()
      log.warn(`topic merge failed, degraded to extractive: ${e instanceof Error ? e.message : e}`)
      body = extractiveSections(items, params, opts.sourcesById)
      meta.degraded = true
    }
  }

  if (signal?.aborted) throw abortErr()

  // 起名：正文前 600 字喂一次小调用；失败/消毒为空→关键词拼接
  let title = ''
  if (llmOk) {
    try {
      title = sanitizeTopicTitle(await opts.llmClient!.generateText({
        system: TOPIC_TITLE_SYSTEM,
        prompt: truncateCodePoints(body, 600),
        maxTokens: 512, // 起名输出虽短，推理模型 reasoning 也要占预算——64 必空
        signal,
        timeoutMs: opts.llmTimeoutMs,
        purpose: 'topic-title',
      }))
    } catch { /* 回退关键词 */ }
  }
  if (!title) title = truncateCodePoints(params.keywords.join('·') || '专题', 30) || '专题'
  meta.title = title

  const { text: citedBody, used } = parseTopicCitations(reflowTopicBody(body), items)
  meta.usedCount = used.length
  meta.durationMs = Date.now() - t0
  meta.excerpt = topicExcerpt(citedBody) // 摘要取已解析引用的正文——不留 [N] 残标记
  meta.status = 'done'
  meta.updatedAt = new Date().toISOString()

  const markdown = renderTopic({
    title, keywords: params.keywords, from: params.from, to: params.to, focus: params.focus,
    hitCount, dedupCount, itemCount: items.length,
    usedItems: used, items,
    sourcesById: opts.sourcesById,
    body: citedBody,
    createdAt: meta.updatedAt, durationMs: meta.durationMs, degraded: meta.degraded, // 「生成于」=本次产出的时间（重生成刷新）
  })

  // tmp+rename 原子落盘，再更索引
  const dir = topicsDirOf(opts.digestsDir)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${meta.id}.md`)
  const tmp = `${file}.tmp`
  await writeFile(tmp, markdown, 'utf8')
  await rename(tmp, file)
  await upsertTopicMeta(opts.digestsDir, meta)
  return meta
}
