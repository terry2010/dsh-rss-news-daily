/**
 * 精选打分：把"今日候选"排成精选序，并把分数与理由写回条目（可解释推荐）。
 *
 * score = 新鲜度(0..1, 24h 半衰) × 0.4
 *       + 源质量(tier 映射 + 用户 weight) × 0.3
 *       + 偏好命中(topic/关键词) × 0.3
 *       + 热度加成 (HN score/comments 归一化) × ≤0.2
 *       − 惩罚（跨日已推 ×0.2 衰减、屏蔽词直接淘汰、隐藏/已读降权）
 */
import type { FeedItem, FeedSource } from './types.js';
export interface Prefs {
    /** 主题权重微调：{"AI": 1.2, "币圈": 0.3}，默认 1 */
    topics: Record<string, number>;
    /** 关键词权重微调（标题/摘要命中加分），默认 1 */
    keywords: Record<string, number>;
    /** 屏蔽词：命中直接淘汰 */
    bannedKeywords: string[];
    /** 源权重微调：normalizeUrl(url) → 倍数，默认 1 */
    sourceWeight: Record<string, number>;
}
export declare const EMPTY_PREFS: Prefs;
export interface ScoreOptions {
    prefs?: Prefs;
    /** 今日已推过的 digestedDay（跨日惩罚对照） */
    digestDay: string;
    now?: Date;
    /** 单主题在精选里的上限；0=不限 */
    perTopicLimit?: number;
    /** 跨日降权窗口（天）：digestedDay 距今 ≤N 才罚；0=不罚（默认 3） */
    penaltyWindowDays?: number;
}
/** 给候选集打分排序并取 top-N（含 perTopicLimit 主题平衡）。写回 score/reasons。 */
export declare function scoreAndSelect(candidates: FeedItem[], sourcesById: ReadonlyMap<string, FeedSource>, n: number, opts: ScoreOptions): FeedItem[];
//# sourceMappingURL=scorer.d.ts.map