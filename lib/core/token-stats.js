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
}
//# sourceMappingURL=token-stats.js.map