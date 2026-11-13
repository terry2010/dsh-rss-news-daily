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
    isIdle?: () => boolean;
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
    private readonly isIdleFn;
    private db;
    private metaObj;
    private srcList;
    private window;
    private dirtyItems;
    private proxyCache;
    /** 条目脏检测：窗口对象套 Proxy，任意层级写入（含 state.* 嵌套）都把根条目记入 dirtyItems——
        save() 只回写脏行。全窗口重写在万级条目库上是秒级事件循环阻塞（API 全卡）。 */
    private track;
    private wrapItem;
    constructor(options: SqliteStoreOptions);
    load(): Promise<void>;
    /** 坏库隔离：关句柄→改名存档→开全新空库（调用方随后重跑 load 建 schema+回填内存） */
    private isolateCorrupt;
    private icTimer;
    private lastIntegrityAt;
    /** integrity_check 节奏：每 30min 探一次——距上次 >24h 且全系统空闲（任务队列空 + 无页面心跳）
        才真正执行（全页扫随库线性增长，忙时/用户在用时跑会卡 API）。
        命中损坏走与启动探针同一隔离路径+重跑 load。 */
    private scheduleIntegrityCheck;
    private integrityTick;
    /** 热恢复：关库 → file 覆盖 store.db → 重新 load（meta/sources/窗口全部重建）。
        调用方须先停抓取/生成；脏窗口清空避免旧数据写回恢复库。 */
    restoreFrom(file: string): Promise<void>;
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
    /** save：脏条目回写 + meta/health 落 kv（写穿透已在各处做，save 兜底）。
        只 UPDATE 自上次 save 以来被改过的行——万级窗口全量重写会把事件循环堵秒级。 */
    save(): Promise<void>;
    /** 清空全部条目（含 FTS 联动+内存窗口）；返回删除数 */
    clearItems(): number;
    /** 年库归档：清退前把将删行按 fetchedAt 年份写进同目录 archive-YYYY.db（同构 schema+FTS 触发器自动建索引）。
        导出失败跳过删除——宁涨不丢数据。返回是否已导出（true=可删）。 */
    private exportToArchive;
    /** 清退：先过期后配额（低质优先 or 最老优先），SQL DELETE；删除前统一走年库归档 */
    private prune;
    /** 跨窗口查询（/items 下推 + 专题候选）：filter+sort+FTS+分页全在 SQL */
    queryItems(opts: {
        day?: string;
        fetchedAfter?: string;
        fetchedBefore?: string;
        category?: string;
        source?: string;
        unread?: boolean;
        q?: string;
        /** 专题：源白名单（精确 IN；空数组=不筛） */
        sources?: string[];
        /** 专题：发布/抓取回退时间区间（COALESCE(NULLIF(publishedAt,''),fetchedAt)） */
        publishedAfter?: string;
        publishedBefore?: string;
        /** 专题：最低评分（COALESCE(llmScore, MIN(10,MAX(0,score*8)))，同 pickFinal 口径） */
        minScore?: number;
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
    /** .db 快照（VACUUM INTO）——全量灾备；先跑 integrity_check 预检：坏库不备份（备份坏库=留存坏档） */
    snapshot(file: string): void;
    close(): void;
}
//# sourceMappingURL=sqlite-store.d.ts.map