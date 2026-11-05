import type { FeedItem, FeedSource } from './types.js';
import type { StoreMeta } from './store.js';
import type { LogSink } from './types.js';
export interface SqliteStoreOptions {
    path: string;
    /** 数量上限：数字或实时读取函数（偏好覆盖走后者，改设置即生效） */
    maxItems?: number | (() => number);
    retentionDays?: () => number;
    pruneLowQuality?: () => boolean;
    fts?: boolean;
    log?: LogSink;
}
/** node:sqlite + FTS5 探测（P1）：不可用/无 FTS5 返回 false → 调用方报错不降级 */
export declare function probeSqlite(): {
    ok: boolean;
    fts: boolean;
};
export declare class SqliteStore {
    readonly path: string;
    private readonly maxItemsFn;
    get maxItems(): number;
    private readonly log;
    private readonly retentionDays;
    private readonly pruneLowQuality;
    private readonly ftsEnabled;
    private db;
    private metaObj;
    private srcList;
    private window;
    constructor(options: SqliteStoreOptions);
    load(): Promise<void>;
    private refreshWindow;
    get meta(): StoreMeta & {
        health?: Record<string, FeedSource["health"]>;
    };
    get sources(): FeedSource[];
    get items(): FeedItem[];
    get health(): Record<string, import("./types.js").SourceHealth>;
    count(): number;
    setHealth(id: string, health: FeedSource['health']): void;
    getHealth(id: string): import("./types.js").SourceHealth;
    addSource(source: FeedSource): void;
    removeItemsBySource(sourceId: string): number;
    removeSource(id: string): boolean;
    addItems(items: FeedItem[]): number;
    markDigested(ids: string[], day: string): void;
    countUndigested(day: string): number;
    /** save：把窗口内条目回写 + meta/health 落 kv（写穿透已在各处做，save 兜底） */
    save(): Promise<void>;
    /** 清空全部条目（含 FTS 联动+内存窗口）；返回删除数 */
    clearItems(): number;
    /** 年库归档：清退前把将删行按 fetchedAt 年份写进同目录 archive-YYYY.db（同构 schema+FTS 触发器自动建索引）。
        导出失败跳过删除——宁涨不丢数据。返回是否已导出（true=可删）。 */
    private exportToArchive;
    /** 清退：先过期后配额（低质优先 or 最老优先），SQL DELETE；删除前统一走年库归档 */
    private prune;
    /** 跨窗口查询（/items 下推）：filter+sort+FTS+分页全在 SQL */
    queryItems(opts: {
        day?: string;
        fetchedAfter?: string;
        fetchedBefore?: string;
        category?: string;
        source?: string;
        unread?: boolean;
        q?: string;
        sort?: 'published' | 'fetched';
        page?: number;
        pageSize?: number;
    }): {
        total: number;
        items: FeedItem[];
    };
    /** NDJSON 流式导出：meta头 + items + sources + digests */
    exportNdjson(file: string, digestsDir: string, scope?: 'all' | 'items' | 'digests'): Promise<number>;
    /** NDJSON 导入：逐行 parse+merge 幂等 */
    importNdjson(file: string, digestsDir: string): Promise<{
        items: number;
        sources: number;
        digests: number;
    }>;
    /** .db 快照（VACUUM INTO）——全量灾备 */
    snapshot(file: string): void;
    close(): void;
}
//# sourceMappingURL=sqlite-store.d.ts.map