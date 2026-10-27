/**
 * 精选打分：把"今日候选"排成精选序，并把分数与理由写回条目（可解释推荐）。
 *
 * score = 新鲜度(0..1, 24h 半衰) × 0.4
 *       + 源质量(tier 映射 + 用户 weight) × 0.3
 *       + 偏好命中(topic/关键词) × 0.3
 *       + 热度加成 (HN score/comments 归一化) × ≤0.2
 *       − 惩罚（跨日已推 ×0.2 衰减、屏蔽词直接淘汰、隐藏/已读降权）
 */

import type { FeedItem, FeedSource } from './types.js'

export interface Prefs {
  /** 主题权重微调：{"AI": 1.2, "币圈": 0.3}，默认 1 */
  topics: Record<string, number>
  /** 关键词权重微调（标题/摘要命中加分），默认 1 */
  keywords: Record<string, number>
  /** 屏蔽词：命中直接淘汰 */
  bannedKeywords: string[]
  /** 源权重微调：normalizeUrl(url) → 倍数，默认 1 */
  sourceWeight: Record<string, number>
}

export const EMPTY_PREFS: Prefs = { topics: {}, keywords: {}, bannedKeywords: [], sourceWeight: {} }

const TIER_SCORE: Record<number, number> = { 1: 1, 2: 0.7, 3: 0.45 }

const DAY_MS = 86400e3

function freshness(item: FeedItem, now: Date): number {
  const t = new Date(item.publishedAt || item.fetchedAt).getTime()
  const ageH = Math.max(0, (now.getTime() - t) / 3600e3)
  return Math.pow(0.5, ageH / 24) // 24h 半衰
}

function sourceScore(src: FeedSource | undefined, prefs: Prefs): number {
  if (!src) return 0.5
  const base = TIER_SCORE[src.tier] ?? 0.45
  return base * (src.weight ?? 1) * (prefs.sourceWeight[src.id] ?? 1)
}

function prefScore(item: FeedItem, prefs: Prefs, reasons: string[]): number {
  let s = 1
  const topicW = prefs.topics[item.topic]
  if (topicW !== undefined && topicW !== 1) {
    s *= topicW
    reasons.push(`主题${topicW > 1 ? '偏好' : '降权'}(${item.topic}×${topicW})`)
  }
  const haystack = `${item.title} ${item.summary}`.toLowerCase()
  for (const [kw, w] of Object.entries(prefs.keywords)) {
    if (kw && w !== 1 && haystack.includes(kw.toLowerCase())) {
      s *= w
      reasons.push(`关键词${w > 1 ? '命中' : '降权'}(${kw})`)
    }
  }
  return s
}

function isBanned(item: FeedItem, prefs: Prefs): string | null {
  const haystack = `${item.title} ${item.summary}`.toLowerCase()
  return prefs.bannedKeywords.find((kw) => kw && haystack.includes(kw.toLowerCase())) ?? null
}

/** 简单热度提取：HN 类条目标题里的 "NN points/comments" 或 source 约定 */
function heat(item: FeedItem): number {
  const m = item.summary.match(/(\d+)\s*(points?|comments?|upvotes?)/i)
    || item.title.match(/(\d+)\s*(points?|comments?|upvotes?)/i)
  if (!m) return 0
  return Math.min(1, Math.log10(Number(m[1]) + 1) / 3) // 1000 → ~1
}

export interface ScoreOptions {
  prefs?: Prefs
  /** 今日已推过的 digestedDay（跨日惩罚对照） */
  digestDay: string
  now?: Date
  /** 单主题在精选里的上限；0=不限 */
  perTopicLimit?: number
}

/** 给候选集打分排序并取 top-N（含 perTopicLimit 主题平衡）。写回 score/reasons。 */
export function scoreAndSelect(
  candidates: FeedItem[],
  sourcesById: ReadonlyMap<string, FeedSource>,
  n: number,
  opts: ScoreOptions,
): FeedItem[] {
  const prefs = opts.prefs ?? EMPTY_PREFS
  const now = opts.now ?? new Date()
  const scored: FeedItem[] = []
  for (const item of candidates) {
    const reasons: string[] = []
    const ban = isBanned(item, prefs)
    if (ban) { item.score = -1; item.reasons = [`屏蔽词(${ban})`]; continue }
    if (item.state.hidden) { item.score = -1; item.reasons = ['已隐藏']; continue }

    const fresh = freshness(item, now)
    if (fresh > 0.8) reasons.push('新鲜')
    const srcS = sourceScore(sourcesById.get(item.sourceId), prefs)
    const prefS = prefScore(item, prefs, reasons)
    const heatS = heat(item)
    if (heatS > 0.3) reasons.push('热度')

    let score = fresh * 0.4 + srcS * 0.3 + prefS * 0.3 + heatS * 0.2
    if (item.digestedDay && item.digestedDay !== opts.digestDay) {
      score *= 0.2
      reasons.push('跨日已推降权')
    }
    if (item.state.liked === 1) { score *= 1.3; reasons.push('已赞') }
    if (item.state.liked === -1) { score *= 0.5; reasons.push('已踩') }
    if (item.state.read) score *= 0.7

    item.score = Math.round(score * 1000) / 1000
    item.reasons = reasons
    scored.push(item)
  }
  scored.sort((a, b) => b.score - a.score || b.fetchedAt.localeCompare(a.fetchedAt))

  const cap = opts.perTopicLimit ?? 0
  if (cap <= 0) return scored.slice(0, n)
  const perTopic = new Map<string, number>()
  const picked: FeedItem[] = []
  const overflow: FeedItem[] = []
  for (const item of scored) {
    const c = perTopic.get(item.topic) ?? 0
    if (c < cap) { perTopic.set(item.topic, c + 1); picked.push(item) }
    else overflow.push(item)
    if (picked.length >= n) break
  }
  // 主题配额用完后仍不足 N：用溢出项按序补齐（宁可满员不空缺——与"硬顶"相反的取向）
  for (const item of overflow) {
    if (picked.length >= n) break
    picked.push(item)
  }
  return picked
}
