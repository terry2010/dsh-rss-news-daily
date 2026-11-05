/** token 用量分账（store.meta.tokenStats）——纯函数便于单测 */
export interface TokenDayStat {
    in: number;
    out: number;
    digest: number;
    score: number;
    translate: number;
}
export interface TokenStats {
    totalIn: number;
    totalOut: number;
    days: Record<string, TokenDayStat>;
}
export type TokenFeature = 'digest' | 'score' | 'translate';
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
}
export interface TokenMeta {
    tokenStats?: TokenStats;
}
/** 把一次 LLM 用量累计进 meta（按日+按功能）；零用量跳过 */
export declare function addTokenStats(meta: TokenMeta, feature: TokenFeature, usage: TokenUsage | undefined, day: string): void;
//# sourceMappingURL=token-stats.d.ts.map