/**
 * 调教解析：自然语言 → 确定性 prefs 改动（不依赖 LLM，LLM 增强留给后续）。
 * 支持句式：多推/多给/增加 X；少推/少给/减少 X；屏蔽/不要/拉黑 X；
 *           重置/清空；权重可叠加（多次调教累积），clamp 到 [0.1, 3]。
 */

import type { Prefs } from './scorer.js'

export interface TuneAction {
  kind: 'topic_up' | 'topic_down' | 'keyword_up' | 'keyword_down' | 'ban' | 'unban' | 'reset'
  target: string
  factor?: number
}

export interface TuneResult {
  ok: boolean
  actions: TuneAction[]
  patch?: Partial<Prefs>
  error?: string
}

const UP_RE = /(?:多推|多给|增加|多来点|多来些|加强|喜欢|想看)\s*([^，。,;；]+)/g
const DOWN_RE = /(?:少推|少给|减少|少来点|少来些|降低|不想看|别推)\s*([^，。,;；]+)/g
const BAN_RE = /(?:屏蔽|拉黑|不要|过滤|去掉|封杀)\s*([^，。,;；]+)/g
const UNBAN_RE = /(?:取消屏蔽|解除屏蔽|放行)\s*([^，。,;；]+)/g
const RESET_RE = /(?:重置|清空|恢复默认|全部重来)/

/** 与 SOURCES.md 类目对齐的粗映射；未匹配项按关键词处理。 */
const TOPIC_WORDS = /^(AI|人工智能|大模型|LLM|科技|技术|开发|程序员|开源|产品|商业|财经|金融|国际|科学|研究|健康|环境|社会|人文|独立博客|币圈|加密货币|crypto|web3|AI ?Agent)/i

const clamp = (n: number) => Math.min(3, Math.max(0.1, n))

function bump(map: Record<string, number>, key: string, factor: number): void {
  const cur = map[key] ?? 1
  map[key] = Math.round(clamp(cur * factor) * 100) / 100
  if (map[key] === 1) delete map[key]
}

/** 解析调教文本 → 动作列表 + prefs patch（调用方 applyTune 落盘）。 */
export function parseTune(text: string, prefs: Prefs): TuneResult {
  const t = text.trim()
  if (!t) return { ok: false, actions: [], error: '空输入' }
  if (RESET_RE.test(t)) {
    return {
      ok: true,
      actions: [{ kind: 'reset', target: '*' }],
      patch: { topics: {}, keywords: {}, bannedKeywords: [], sourceWeight: {} },
    }
  }

  const patch: Prefs = {
    topics: { ...prefs.topics },
    keywords: { ...prefs.keywords },
    bannedKeywords: [...prefs.bannedKeywords],
    sourceWeight: { ...prefs.sourceWeight },
  }
  const actions: TuneAction[] = []

  const segments = (re: RegExp, apply: (target: string) => void): void => {
    for (const m of t.matchAll(re)) {
      const target = m[1].trim().replace(/[的了和并以及].*$/, '').trim()
      if (target) apply(target)
    }
  }

  segments(UP_RE, (target) => {
    const isTopic = TOPIC_WORDS.test(target) || target in patch.topics
    if (isTopic) { bump(patch.topics, target, 1.3); actions.push({ kind: 'topic_up', target, factor: 1.3 }) }
    else { bump(patch.keywords, target, 1.5); actions.push({ kind: 'keyword_up', target, factor: 1.5 }) }
  })
  segments(DOWN_RE, (target) => {
    const isTopic = TOPIC_WORDS.test(target) || target in patch.topics
    if (isTopic) { bump(patch.topics, target, 0.7); actions.push({ kind: 'topic_down', target, factor: 0.7 }) }
    else { bump(patch.keywords, target, 0.6); actions.push({ kind: 'keyword_down', target, factor: 0.6 }) }
  })
  segments(BAN_RE, (target) => {
    if (!patch.bannedKeywords.includes(target)) patch.bannedKeywords.push(target)
    actions.push({ kind: 'ban', target })
  })
  segments(UNBAN_RE, (target) => {
    const i = patch.bannedKeywords.indexOf(target)
    if (i >= 0) patch.bannedKeywords.splice(i, 1)
    actions.push({ kind: 'unban', target })
  })

  if (actions.length === 0) {
    // 兜底：把整句当关键词加权（调教总是"立即生效点什么"，不静默失败）
    bump(patch.keywords, t.slice(0, 12), 1.3)
    actions.push({ kind: 'keyword_up', target: t.slice(0, 12), factor: 1.3 })
  }
  return { ok: true, actions, patch }
}

// ==== 反馈学习：👍/👎 → 权重微调（阅读习惯自学） ====

/** 从标题抽关键词：CJK 连续段 + 英文词，≥2 字，取前 3。 */
export function extractKeywords(title: string): string[] {
  const keys: string[] = []
  const cjk = title.match(/[一-鿿]{2,}/g) || []
  const en = title.match(/[A-Za-z][A-Za-z0-9-]{3,}/g) || []
  for (const w of [...cjk, ...en].slice(0, 6)) {
    const k = w.length > 8 ? w.slice(0, 8) : w
    if (!keys.includes(k)) keys.push(k)
    if (keys.length >= 3) break
  }
  return keys
}

/**
 * 👍 → topic×1.1、title 关键词×1.15、source×1.05；
 * 👎 → 全部反向（×0.9/×0.87/×0.95）。返回可合并的完整 Prefs 映射。
 */
export function learnFromFeedback(
  prefs: Prefs,
  item: { topic: string; title: string; sourceId: string },
  action: 'like' | 'dislike',
): { patch: Prefs; learned: string[] } {
  const patch: Prefs = {
    topics: { ...prefs.topics },
    keywords: { ...prefs.keywords },
    bannedKeywords: [...prefs.bannedKeywords],
    sourceWeight: { ...prefs.sourceWeight },
  }
  const learned: string[] = []
  const up = action === 'like'
  const topicF = up ? 1.1 : 0.9
  const kwF = up ? 1.15 : 0.87
  const srcF = up ? 1.05 : 0.95

  if (item.topic) { bump(patch.topics, item.topic, topicF); learned.push(`topic:${item.topic}×${topicF}`) }
  for (const kw of extractKeywords(item.title)) {
    bump(patch.keywords, kw, kwF)
    learned.push(`kw:${kw}×${kwF}`)
  }
  bump(patch.sourceWeight, item.sourceId, srcF)
  learned.push(`src:${item.sourceId.slice(0, 24)}×${srcF}`)

  return { patch, learned }
}
