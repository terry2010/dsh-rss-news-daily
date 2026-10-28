/** token 用量分账（store.meta.tokenStats）——纯函数便于单测 */
export interface TokenDayStat { in: number; out: number; digest: number; score: number; translate: number }
export interface TokenStats { totalIn: number; totalOut: number; days: Record<string, TokenDayStat> }
export type TokenFeature = 'digest' | 'score' | 'translate'
export interface TokenUsage { inputTokens: number; outputTokens: number }
export interface TokenMeta { tokenStats?: TokenStats }

/** 把一次 LLM 用量累计进 meta（按日+按功能）；零用量跳过 */
export function addTokenStats(meta: TokenMeta, feature: TokenFeature, usage: TokenUsage | undefined, day: string): void {
  if (!usage || (usage.inputTokens + usage.outputTokens) <= 0) return
  const st = meta.tokenStats ?? (meta.tokenStats = { totalIn: 0, totalOut: 0, days: {} })
  const d = st.days[day] ?? (st.days[day] = { in: 0, out: 0, digest: 0, score: 0, translate: 0 })
  const total = usage.inputTokens + usage.outputTokens
  st.totalIn += usage.inputTokens; st.totalOut += usage.outputTokens
  d.in += usage.inputTokens; d.out += usage.outputTokens; d[feature] += total
}
