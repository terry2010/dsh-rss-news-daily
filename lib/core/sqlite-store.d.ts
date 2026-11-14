import type { FeedItem, FeedSource } from './types.js';
import type { StoreMeta } from './store.js';
import type { LogSink } from './types.js';
export interface SqliteStoreOptions {
    path: string;
    /** 数量上限：数字或实时读取函数（偏好覆盖走后者，改设置即生效） */
    maxItems?: number | (() => number);
    /** 内存窗口上限（默认 30000）——与 maxItems(库配额) 解耦：高摄入用户把配额调到
        百万/十亿级后窗口仍只物化最近 N 条，不调即 OOM；窗口=工作集不是数据边界 */
    windowItems?: number;
    retentionDays?: () => number;
    pruneLowQuality?: () => boolean;
    fts?: boolean;
    isIdle?: () => boolean;
    log?: LogSink;
}
/** queryItems/queryItemsChunked 共用的查询选项 */
export interface QueryItemsOpts {
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
    /** 日报候选：排除已在某日消化过的条目（digestedDay 存 '' 非 NULL——IS NULL 一并兼容） */
    excludeDigestedDay?: string;
    /** 日报候选：分类白名单；空 topic 按 '综合' 归位（与内存过滤 i.topic||'综合' 同口径） */
    topics?: string[];
    /** 非分页直取上限（候选池场景）：设了就不分页不计数，total=-1+totalPending */
    limit?: number;
    /** limit 模式下剔除 content/aiSummary 两列重文本（行体积 ~95% 在这两列）；
        挑出小集合后用 hydrateItems() 补水。lite 行的 content/aiSummary 是缺值，persistItems 内有 __lite 标记自动兜底 */
    lite?: boolean;
    sort?: 'published' | 'fetched';
    page?: number;
    pageSize?: number;
    /** 冷启动首屏：窗口未就绪时跳过 COUNT 全表扫描，先回页数据；total=-1+totalPending 标记让前端出列表后补查 */
    skipTotal?: boolean;
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
    private readonly windowSize;
    private readonly log;
    private readonly retentionDays;
    private readonly pruneLowQuality;
    private readonly ftsEnabled;
    private readonly isIdleFn;
    private db;
    private metaObj;
    private srcList;
    private window;
    private windowReady;
    private windowGen;
    private countsReady;
    private countsDeferred;
    private stateColsReady;
    private ddlQueue;
    private ensuredArchives;
    private archiveTodo;
    private lastArchiveMaintAt;
    private dirtyItems;
    private proxyCache;
    /** 条目脏检测：窗口对象套 Proxy，任意层级写入（含 state.* 嵌套）都把根条目记入 dirtyItems——
        save() 只回写脏行。全窗口重写在万级条目库上是秒级事件循环阻塞（API 全卡）。 */
    private track;
    private wrapItem;
    constructor(options: SqliteStoreOptions);
    /** 窗口实际容量：min(窗口上限, 库配额)——配额比窗口小的库窗口仍是全量，行为与旧版一致 */
    private winCap;
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
    /** 年库巡检：每日把同目录 archive-*.db 入列，每个空闲 tick 收敛一个文件做同构 schema。
        旧年库的计数器种子是一次性 COUNT——摊到不同空闲窗口不叠加冻结。 */
    private archiveMaintainTick;
    /** 热恢复：关库 → file 覆盖 store.db → 重新 load（meta/sources/窗口全部重建）。
        调用方须先停抓取/生成；脏窗口清空避免旧数据写回恢复库。
        用 renameSync 不用 copyFileSync：pending 与目标同目录同文件系统，rename 是 O(1) 原子换名——
        大库恢复从"同步拷贝 GB 级文件（分钟级冻结）"变瞬时。 */
    restoreFrom(file: string): Promise<void>;
    private refreshWindow;
    /** 分块预热：LIMIT/OFFSET 分批取行+逐行包裹，块间 setImmediate 让渡——事件循环不被一坨同步工作堵死。
        预热期间有写入（addItems/refreshWindow/clearItems）→ 代际变了，半成品弃之改同步重建（正确性优先）。 */
    /** 计数器种子+触发器：同 SAVEPOINT 原子执行——种子是绝对值重放，写入不可能穿插其间（单线程单写者）；
        触发器在种子后创建不会漏计。幂等可重跑（restoreFrom 后自动自愈）。
        用 SAVEPOINT 不用 BEGIN：importNdjson 的 for-await 事务可能与预热期交叠——
        SAVEPOINT 可嵌在外层事务内（独立时自成隐式事务），不会撞"within a transaction"
        也不会在失败时误回滚外层事务。若整个外层事务事后被回滚，种子消失→count() 缺失防御兜底。 */
    private seedCounters;
    /** state_hidden/state_read 生成列：VIRTUAL=纯元数据 ALTER（任何规模瞬时）——无需随大库推迟；
        复合索引让 unread/可见筛选走等值查找。 */
    private ensureStateCols;
    /** 推迟 DDL 任务：大库上的单语句 O(库) 操作（计数器种子/索引新建）逐条摊进空闲 tick */
    private runDdlJob;
    private warmWindow;
    get meta(): StoreMeta & {
        health?: Record<string, FeedSource["health"]>;
    };
    get sources(): FeedSource[];
    get items(): FeedItem[];
    get health(): Record<string, import("./types.js").SourceHealth>;
    count(): number;
    /** 可见总数（总数-屏蔽）——queryItems 无筛选时用它替代 json_extract 全扫 COUNT */
    private visibleCount;
    /** 按 id 取条目：窗口先查（代理对象，改 state 标脏），未命中走主键点查——
        高摄入下被挤出窗口但仍在库的条目照常可已读/屏蔽/喜欢。 */
    getItem(id: string): FeedItem | undefined;
    /** 非窗口条目标脏：queryItems 取出的普通对象经管线写入 llmScore 等字段后，
        借 dirtyItems→save() 的既有 UPDATE 通道回写（窗口代理是另一条通道）。
        lite 行（content/aiSummary 缺值）先自动补水——否则 save() 会把缺省 '' 当真值覆盖正文字段。 */
    persistItems(items: FeedItem[]): void;
    /** lite 候选补水：批量点查 content/aiSummary 填回传入对象（IN 分块，单次点查微秒级）。
        只写存在列的行——查不到的 id 保留原值（含 lite 缺省 ''）。persistItems 前置调用。 */
    hydrateItems(items: FeedItem[]): void;
    setHealth(id: string, health: FeedSource['health']): void;
    getHealth(id: string): import("./types.js").SourceHealth;
    addSource(source: FeedSource): void;
    /** 按源分块删除：sourceId 索引批取 id→DELETE→让渡——单语句 DELETE 在百万级匹配时
        是分钟级冻结+巨型 WAL（计数器/FTS 触发器逐行触发）。源删除=用户明确不要了，不归档。 */
    removeItemsBySource(sourceId: string): Promise<number>;
    removeSource(id: string): Promise<boolean>;
    addItems(items: FeedItem[]): number;
    markDigested(ids: string[], day: string): void;
    countUndigested(day: string): number;
    /** save：脏条目回写 + meta/health 落 kv（写穿透已在各处做，save 兜底）。
        只 UPDATE 自上次 save 以来被改过的行——万级窗口全量重写会把事件循环堵秒级。 */
    save(): Promise<void>;
    /** 清空全部条目（含 FTS+内存窗口）；返回删除数。
        大库走 DROP+重建：DELETE 会逐行触发计数器/FTS 触发器且 WAL 涨到库体量——
        DROP TABLE 是摘 B-tree 根的元数据级操作，空库重建 schema 全部瞬时。 */
    clearItems(): Promise<number>;
    /** 年库同构 schema：SCHEMA+纪元+FTS+计数器种子/触发器+状态列+排序索引——
        与热库 warmWindow 同一套硬化件，否则年库永远是"落后一代"的裸库（apiArchive 全扫）。
        每文件每进程只做一次；种子是首次写入时的一次性 COUNT（旧大年库付一次全扫）。 */
    private ensureArchiveSchema;
    /** 年库归档：把给定 id 集的行按 fetchedAt 年份写进同目录 archive-YYYY.db（同构 schema+FTS 触发器自动建索引）。
        导出失败跳过删除——宁涨不丢数据。返回是否已导出（true=可删）。 */
    private archiveIds;
    /** 窗口原位剔除已删 id——不整窗 SELECT* 重建（30k 行重载≈1s 同步，高摄入下每周期都付） */
    private dropWindowIds;
    /** 分块清退：索引批取 id（LIMIT 有界）→ 归档 → 删除 → 让渡。
        单语句全量 DELETE 随行数线性冻结事件循环——大库下必须摊成无感后台批。
        selectIds 必须是索引驱动的取 id 语句（不含 LIMIT——由循环按批追加）。 */
    private pruneByIds;
    /** 清退：先过期后配额（低质优先 or 最老优先）——分块归档+删除，块间让渡 */
    private prune;
    /** WHERE/FROM/排序键构建：queryItems 分页与 queryItemsChunked 直取共用同一套谓词 */
    private itemQuery;
    /** 跨窗口查询（/items 下推 + 专题候选）：filter+sort+FTS+分页全在 SQL */
    queryItems(opts: QueryItemsOpts): {
        total: number;
        totalPending?: boolean;
        items: FeedItem[];
    };
    /** 大候选集分块直取（异步）：单条 SELECT 物化万级行仍是数百 ms 同步段（启动补跑日报正撞首屏）——
        切成 4k 片+片间让渡，API 请求插缝服务。列/lite 语义与 limit 模式一致。 */
    queryItemsChunked(opts: QueryItemsOpts & {
        limit: number;
    }): Promise<FeedItem[]>;
    /** NDJSON 流式导出：meta头 + items + sources + digests */
    exportNdjson(file: string, digestsDir: string, scope?: 'all' | 'items' | 'digests'): Promise<number>;
    /** NDJSON 导入：逐行 parse+merge 幂等 */
    importNdjson(file: string, digestsDir: string): Promise<{
        items: number;
        sources: number;
        digests: number;
    }>;
    /** 库文件字节数——备份/完整性检查的大小门控依据 */
    dbFileSize(): number;
    get dbPath(): string;
    /** WAL 合并入主文件并截断——此后 .db 文件自身就是一致快照点（直接拷贝即有效备份，免 VACUUM 全量重写） */
    checkpointWal(): void;
    /** .db 快照（VACUUM INTO）——全量灾备；先跑 quick_check 预检：坏库不备份（备份坏库=留存坏档）。
        仅小库走此路径（VACUUM INTO 全量重写随库线性——大库备份走 checkpointWal+文件拷贝）。 */
    snapshot(file: string): void;
    close(): void;
}
//# sourceMappingURL=sqlite-store.d.ts.map