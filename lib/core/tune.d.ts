/**
 * 调教解析：自然语言 → 确定性 prefs 改动（不依赖 LLM，LLM 增强留给后续）。
 * 支持句式：多推/多给/增加 X；少推/少给/减少 X；屏蔽/不要/拉黑 X；
 *           重置/清空；权重可叠加（多次调教累积），clamp 到 [0.1, 3]。
 */
import type { Prefs } from './scorer.js';
export interface TuneAction {
    kind: 'topic_up' | 'topic_down' | 'keyword_up' | 'keyword_down' | 'ban' | 'unban' | 'reset';
    target: string;
    factor?: number;
}
export interface TuneResult {
    ok: boolean;
    actions: TuneAction[];
    patch?: Partial<Prefs>;
    error?: string;
}
/** 解析调教文本 → 动作列表 + prefs patch（调用方 applyTune 落盘）。 */
export declare function parseTune(text: string, prefs: Prefs): TuneResult;
/** 从标题抽关键词：CJK 连续段 + 英文词，≥2 字，取前 3。 */
export declare function extractKeywords(title: string): string[];
/**
 * 👍 → topic×1.1、title 关键词×1.15、source×1.05；
 * 👎 → 全部反向（×0.9/×0.87/×0.95）。返回可合并的完整 Prefs 映射。
 */
export declare function learnFromFeedback(prefs: Prefs, item: {
    topic: string;
    title: string;
    sourceId: string;
}, action: 'like' | 'dislike'): {
    patch: Prefs;
    learned: string[];
};
//# sourceMappingURL=tune.d.ts.map