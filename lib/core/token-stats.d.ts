/** token 用量分账（store.meta.tokenStats）——纯函数便于单测 */
export interface TokenDayStat {
    in: number;
    out: number;
    /** 命中缓存的输入 token（宿主记账约定：inputTokens 不含缓存，cacheRead 独立维度） */
    cached?: number;
    digest: number;
    score: number;
    translate: number;
    topic: number;
    /** 各功能桶的输入/输出/缓存拆分（旧日期缺省=只有合计值） */
    featureIO?: Partial<Record<TokenFeature, {
        in: number;
        out: number;
        cached?: number;
    }>>;
}
export interface TokenStats {
    totalIn: number;
    totalOut: number;
    totalCached?: number;
    days: Record<string, TokenDayStat>;
}
export type TokenFeature = 'digest' | 'score' | 'translate' | 'topic';
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
}
export interface TokenMeta {
    tokenStats?: TokenStats;
}
/** 把一次 LLM 用量累计进 meta（按日+按功能）；零用量跳过 */
export declare function addTokenStats(meta: TokenMeta, feature: TokenFeature, usage: TokenUsage | undefined, day: string): void;
//# sourceMappingURL=token-stats.d.ts.map