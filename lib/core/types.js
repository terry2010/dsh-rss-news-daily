/** 核心类型：rss-digest 兼容字段名（移植模块直接用）+ 本项目扩展字段。 */
/** 旧闻阈值：publishedAt 早于抓取时间 7 天（Google News 搜索源会用相关度回填旧文） */
export const STALE_MS = 7 * 24 * 3600 * 1000;
export function isStaleItem(it) {
    const pub = Date.parse(it.publishedAt || ''), got = Date.parse(it.fetchedAt || '');
    return Number.isFinite(pub) && Number.isFinite(got) && got - pub > STALE_MS;
}
export const noopLog = {
    info() { },
    warn() { },
    error() { },
};
//# sourceMappingURL=types.js.map