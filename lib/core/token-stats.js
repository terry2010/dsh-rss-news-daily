/** days 明细保留上限（audit P3）：按日桶无清理会无限增长；400 天 ≈ 13 个月，超出删最旧（totalIn/totalOut 是终身累计不受影响） */
const DAYS_CAP = 400;
/** 把一次 LLM 用量累计进 meta（按日+按功能）；零用量跳过 */
export function addTokenStats(meta, feature, usage, day) {
    const tin = Math.max(0, usage?.inputTokens ?? 0), tout = Math.max(0, usage?.outputTokens ?? 0); // 负增量（流累计值跨重试错位）钳 0 防污染
    const tcache = Math.max(0, usage?.cacheReadTokens ?? 0);
    if (tin + tout + tcache <= 0)
        return;
    const st = meta.tokenStats ?? (meta.tokenStats = { totalIn: 0, totalOut: 0, days: {} });
    const d = st.days[day] ?? (st.days[day] = { in: 0, out: 0, digest: 0, score: 0, translate: 0, topic: 0 });
    const total = tin + tout;
    st.totalIn += tin;
    st.totalOut += tout;
    st.totalCached = (st.totalCached ?? 0) + tcache;
    d.in += tin;
    d.out += tout;
    d.cached = (d.cached ?? 0) + tcache;
    d[feature] = (d[feature] ?? 0) + total; // 旧数据可能缺新桶字段（topic）——??0 兼容
    const fio = d.featureIO ?? (d.featureIO = {});
    const fb = fio[feature] ?? (fio[feature] = { in: 0, out: 0 });
    fb.in += tin;
    fb.out += tout;
    fb.cached = (fb.cached ?? 0) + tcache;
    const keys = Object.keys(st.days);
    if (keys.length > DAYS_CAP)
        for (const k of keys.sort().slice(0, keys.length - DAYS_CAP))
            delete st.days[k];
}
//# sourceMappingURL=token-stats.js.map