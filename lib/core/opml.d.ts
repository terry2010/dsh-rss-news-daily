export interface OpmlEntry {
    title: string;
    xmlUrl: string;
    htmlUrl?: string;
    category?: string;
}
/** 解析 OPML 文本 → 条目列表（按 outline 分组继承分类名）。 */
export declare function parseOpml(text: string): OpmlEntry[];
/** 导出条目 → OPML 文本（按 category 分组为一级 outline）。 */
export declare function generateOpml(entries: Array<{
    title: string;
    url: string;
    category?: string;
}>, title?: string): string;
//# sourceMappingURL=opml.d.ts.map