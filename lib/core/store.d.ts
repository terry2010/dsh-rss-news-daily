/**
 * Local JSON persistence for sources, items, and metadata.
 *
 * - Single JSON document, written atomically (temp file + rename) to survive
 *   process kills.
 * - Versioned schema with a defensive migration hook (nothing to migrate at
 *   schema 1, but future formats land here).
 * - Corrupted documents are quarantined (renamed aside) instead of being
 *   silently deleted, and a fresh store starts in their place.
 *
 * Pure module: node:fs / node:path only, no dsh dependency.
 */
import type { FeedItem, FeedSource, LogSink } from './types.js';
export declare const STORE_SCHEMA = 1;
export interface StoreMeta {
    /** ISO timestamp of the latest successful fetch cycle. */
    lastFetchAt: string;
    /** ISO timestamp of the latest digest generation. */
    lastDigestAt: string;
    /** Date key (YYYY-MM-DD in the digest timezone) of the latest digest. */
    lastDigestDay: string;
    /** 最近一次抓取周期新增条目数（状态栏"本次新增"） */
    lastFetchAdded?: number;
    lastFetchStartedAt?: string;
    deletedBuiltin?: string[];
    /** token 用量统计：按日+按功能分账（digest 日报/score 评分快报/translate 翻译/topic 专题） */
    tokenStats?: {
        totalIn: number;
        totalOut: number;
        days: Record<string, {
            in: number;
            out: number;
            digest: number;
            score: number;
            translate: number;
            topic: number;
        }>;
    };
    /** LLM 调用耗时 EMA（global 全局均值 + byPurpose 分桶）——重启后首轮即可给 ETA；随 save() 落盘 */
    llmDurEma?: {
        global?: number;
        byPurpose?: Record<string, number>;
    };
}
export interface StoreData {
    schema: number;
    meta: StoreMeta;
    sources: FeedSource[];
    items: FeedItem[];
    /** 全源健康度表（含纯内置源）：key=normalizeUrl(url) */
    health: Record<string, FeedSource['health']>;
}
/** Safely normalize an unknown value into {@link StoreData}, or null. */
export declare function normalizeStoreData(value: unknown): StoreData | null;
/** spread 保留扩展字段后，对已知类型字段做消毒——防手写坏数据在运行期崩掉（如 health:5） */
export declare function sanitizeSource(s: Record<string, unknown>): Record<string, unknown>;
/** 同上，条目侧：state/reasons/score 畸形时回默认。 */
export declare function sanitizeItem(it: Record<string, unknown>): Record<string, unknown>;
export interface StoreOptions {
    /** File path of the JSON store. */
    path: string;
    /** Maximum number of items kept (oldest fetched are pruned on save). 数字或实时读取函数（偏好覆盖走后者） */
    maxItems?: number | (() => number);
    /** 条目保留天数（0=不按时间过期，仅数量上限）；每次 prune 实时读取 */
    retentionDays?: () => number;
    /** 数量超限清退时低质优先（llmScore/启发式分最低的先走）；false=最老的先走 */
    pruneLowQuality?: () => boolean;
    log?: LogSink;
}
/**
 * In-memory working copy of the store document with persisted side effects.
 * Mutation methods update memory; persistence happens on {@link save}.
 */
/** Store 公共契约——JSON Store 与 SqliteStore 共同实现（DESIGN-SQLITE.md P2） */
export interface StoreLike {
    /** 清空全部条目；返回删除数 */
    clearItems(): number;
    readonly path: string;
    readonly maxItems: number;
    readonly meta: StoreMeta;
    readonly sources: FeedSource[];
    readonly items: FeedItem[];
    readonly health: Record<string, FeedSource['health']>;
    load(): Promise<void>;
    save(): Promise<void>;
    addItems(items: FeedItem[]): number;
    addSource(source: FeedSource): void;
    removeItemsBySource(sourceId: string): number;
    removeSource(id: string): boolean;
    setHealth(id: string, health: FeedSource['health']): void;
    getHealth(id: string): FeedSource['health'] | undefined;
    markDigested(ids: string[], day: string): void;
    countUndigested(day: string): number;
}
export declare class Store {
    readonly path: string;
    private readonly maxItemsFn;
    get maxItems(): number;
    private readonly log;
    private readonly retentionDays;
    private readonly pruneLowQuality;
    private data;
    private dirty;
    private writeQueue;
    constructor(options: StoreOptions);
    get meta(): StoreMeta;
    get sources(): FeedSource[];
    get items(): FeedItem[];
    /** 全源健康度表（含纯内置源），直接改引用后需 save() 持久化。 */
    get health(): StoreData['health'];
    /** 写某源健康度并标脏（fetchOne 每轮调用）。 */
    setHealth(id: string, health: FeedSource['health']): void;
    getHealth(id: string): FeedSource['health'] | undefined;
    /** Load the document from disk; missing/corrupt files start empty. */
    load(): Promise<void>;
    /** Persist the in-memory state atomically. Never throws. */
    save(): Promise<void>;
    /** 清退：先按保留天数过期，再按数量上限砍（低质优先 or 最老优先）。 */
    private prune;
    /** Rename a corrupt file aside so the original is moved, not copied. */
    private quarantine;
    addSource(source: FeedSource): void;
    removeSource(id: string): boolean;
    removeItemsBySource(sourceId: string): number;
    /** Append items not yet present by id, marking duplicates by identity. */
    addItems(items: FeedItem[]): number;
    clearItems(): number;
    /** Mark digest inclusion: set digestedDay for the given item ids. */
    markDigested(ids: string[], day: string): void;
    /** Count items whose digestedDay differs from `day` (candidates for digest). */
    countUndigested(day: string): number;
}
/** Items eligible for a digest with the given day key, newest first. */
export declare function undigestedItems(items: FeedItem[], day: string, limit: number): FeedItem[];
//# sourceMappingURL=store.d.ts.map