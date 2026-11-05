/**
 * FetchCycle：一轮"生效源表 → 并发抓取 → 解析 → 去重 → 入 store → 健康度"编排。
 *
 * 生效源表 = 内置目录(src/sources.builtin.json) ∪ config.sources ∪ store 用户源，
 * 按规范化 URL 去重（用户条目覆盖内置同名源，见 SOURCES.md §1）。
 * 健康度：连续 3 次失败 → 24h 冷却跳过；不删源，可手动复活。
 */
import type { FeedSource, FetchCycleResult, LogSink } from './core/types.js';
import type { StoreLike } from './core/store.js';
import type { createFetcher } from './core/fetcher.js';
export interface FetchCycleOptions {
    /** 手动抓取：绕过 24h 冷却重试失败源（调度路径不传） */
    force?: boolean;
    /** 中止信号：取消后 worker 不再领取新源（在飞的抓完收尾） */
    signal?: AbortSignal;
    /** 每完成一个源回调一次（进度上报） */
    onSourceStart?: (src: {
        url: string;
    }) => void;
    onSourceDone?: () => void;
    fetch: ReturnType<typeof createFetcher>;
    store: StoreLike;
    sources: FeedSource[];
    maxItemsPerSource: number;
    storeContentChars: number;
    concurrency: number;
    dedupeThreshold: number;
    /** 近似去重窗口（天）：仅对窗口内条目做 Jaccard；0=不限 */
    dedupeWindowDays?: number;
    log?: LogSink;
    now?: () => Date;
}
/** URL 规范化：去追踪参数（utm_、fbclid、gclid 等）与结尾斜杠（OPML/源去重共用） */
export declare function normalizeUrl(raw: string): string;
/** 生效源表：内置 ∪ config 预置 ∪ store 用户源，按规范化 URL 合并（用户覆盖内置）。 */
export declare function effectiveSources(configSources: Array<{
    url: string;
    title?: string;
    category?: string;
    enabled?: boolean;
    summarize?: boolean;
    proxy?: string | boolean;
    cooldownHours?: number;
}>, store: StoreLike): FeedSource[];
export interface AddSourceOptions {
    url: string;
    title?: string;
    category?: string;
}
/** 预览：验证+抓取+解析+分类，不落库；确认时由 addSource 重抓写入 */
export declare function previewSource(fetch: ReturnType<typeof createFetcher>, store: StoreLike, opts: AddSourceOptions, classify?: (feed: {
    title: string;
    items: {
        title: string;
    }[];
}) => Promise<string>): Promise<{
    url: string;
    title: string;
    category?: string;
    viaProxy: boolean;
    items: {
        title: string;
        link: string;
    }[];
}>;
export declare function addSource(fetch: ReturnType<typeof createFetcher>, store: StoreLike, opts: AddSourceOptions, classify?: (feed: {
    title: string;
    items: {
        title: string;
    }[];
}) => Promise<string>): Promise<FeedSource>;
/** 移除源（连带其条目）并落盘。内置源只支持停用不支持删除——停用走 store 覆盖层。 */
export declare function restoreBuiltinSource(store: StoreLike, url: string): Promise<boolean>;
export declare function removeSource(store: StoreLike, urlOrId: string, isBuiltin?: boolean): Promise<boolean>;
/** 启用/停用源：内置源在 store 写覆盖层，用户源直接改记录。
 *  builtinMeta 不传时自动查内置目录，防显示名退化为 URL。 */
export declare function setSourceEnabled(store: StoreLike, urlOrId: string, enabled: boolean, builtinMeta?: {
    title: string;
    category: string;
}): Promise<void>;
/** 切换源级 AI 摘要开关（summarize=false 的源，日报里用 feed 原摘要、不调 LLM）。
 *  currentEnabled 传当前生效 enabled——写覆盖层时保留，避免误复活被 config 停用的源。 */
/** 更新源的任意可编辑属性（title/category/proxy/cooldownHours 走 override；enabled/summarize 由专门开关管，但这里一并兜住）。 */
export declare function updateSource(store: StoreLike, urlOrId: string, patch: {
    title?: string;
    category?: string;
    enabled?: boolean;
    summarize?: boolean;
    proxy?: string | boolean | null;
    cooldownHours?: number | null;
    url?: string;
}, currentEnabled?: boolean): Promise<void>;
export declare function setSourceSummarize(store: StoreLike, urlOrId: string, summarize: boolean, currentEnabled?: boolean): Promise<void>;
export interface OpmlImportResult {
    added: number;
    duplicated: number;
    skipped: number;
    details: Array<{
        url: string;
        action: 'added' | 'duplicated' | 'skipped';
        reason?: string;
    }>;
}
/** OPML 导入编排：规范化去重 + 判重（store∪builtin∪config），明细可核对。
 *  批量导入不做逐源抓取校验（数十源的串行校验太慢）——健康度由后续 fetch 循环接管。 */
export declare function importOpml(store: StoreLike, opmlText: string, configSources?: Array<{
    url: string;
}>): Promise<OpmlImportResult>;
/** OPML 导出：生效源表 → opml 文本。 */
export declare function exportOpml(store: StoreLike, configSources: Array<{
    url: string;
    title?: string;
    category?: string;
    enabled?: boolean;
}>): Promise<string>;
/** 跑一轮抓取；单源失败就地标注不影响其它源（铁律 2）。 */
export declare function runFetchCycle(opts: FetchCycleOptions): Promise<FetchCycleResult>;
//# sourceMappingURL=service.d.ts.map