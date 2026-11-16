/**
 * 非标抓取方法注册表：伴随插件经 rndSources.registerMethod 注入自定义源适配器。
 * FeedSource.method 原是预留字段——这里启用它：method !== 'direct' 时
 * fetchOne 查本表分发，handler 返回 RawItem[] 后与 RSS 路径汇合
 * （toItem/去重/入库/健康度全部由 fetchOne 统一处理，adapter 只管拿数+映射）。
 *
 * 公开面：MethodHandler / RawItem / MethodCtx / SourceDef 经 index.ts re-export
 * 给伴随插件（devDependencies: file: 引用拿类型），进公开 API semver。
 */
import type { FeedSource, LogSink } from './types.js';
import type { createFetcher } from './fetcher.js';
import type { StoreLike } from './store.js';
/** 非标抓取 handler 返回的原始条目——与 ParsedFeedItem 同构，字段可省（分发处补默认）。 */
export interface RawItem {
    /** 源内唯一 id；缺省回退 link/title。建议带源前缀（cls_…/j10_…）防跨源撞 guid */
    id?: string;
    title: string;
    link?: string;
    summary?: string;
    content?: string;
    /** ISO 时间；缺省取抓取时刻。isStaleItem 依赖——快讯源务必给真实发布时间 */
    publishedAt?: string;
}
/** adapter 收到的上下文：复用主插件护栏，不暴露内部实现 */
export interface MethodCtx {
    /** 主插件策略 fetcher：SSRF/超时/大小限制/代理/重试全部继承；init 可传 headers/accept */
    fetch: ReturnType<typeof createFetcher>;
    log: LogSink;
    signal?: AbortSignal;
    /** adapter 私有状态持久化（金十 x-app-id 缓存、cls last_time 水位）——落 store.meta.methodState */
    kv: {
        get(k: string): string | undefined;
        set(k: string, v: string): void;
    };
}
export type MethodHandler = (src: FeedSource, ctx: MethodCtx) => Promise<RawItem[]>;
export declare const registry: Map<string, MethodHandler>;
export declare const registerMethod: (name: string, h: MethodHandler) => void;
export declare const methodHandler: (name: string) => MethodHandler | undefined;
/** adapter 游标 kv：写进 store.meta.methodState[srcId]，持久化随后续 store.save() 落盘 */
export declare function methodKv(store: StoreLike, srcId: string): MethodCtx['kv'];
/**
 * addSources 入参（伴随插件 → rndSources.addSources）——字段名对齐 toFeedSource，
 * 不用 sources.*.json 的 name/defaultEnabled，避免映射层洗字段。
 */
export interface SourceDef {
    url: string;
    title: string;
    /** 抓取方式：'direct'（缺省）=RSS/Atom 常规抓取；其余经 registerMethod 注册的 handler */
    method?: string;
    category?: string;
    tier?: 1 | 2 | 3;
    lang?: 'zh' | 'en';
    enabled?: boolean;
    /** 条目是否生成 AI 逐条摘要（默认 true；快讯类建议 false） */
    summarize?: boolean;
    /** 纯流源：只入库+展示，全程不碰 AI（评分/摘要/翻译/stub 判定），不进日报/通配快报 */
    stream?: boolean;
    proxy?: string | boolean;
    cooldownHours?: number;
}
/** registerView 入参：伴随插件给阅读器贡献的 iframe 视图（页自己挂在 webServer 下） */
export interface ViewDef {
    /** 视图 id（同一 provider 内唯一；tab id 用） */
    id: string;
    /** tab 显示名 */
    title: string;
    /** 页面地址——通常是本插件 webServer 挂载路径，如 '/dsh-news-kuaixun/' */
    url: string;
}
/** registerBriefType 入参：伴随插件注册快报类型（字段同 prefs.briefTypes 元素，id 冲突时用户已存配置优先） */
export interface BriefTypeDef {
    id: string;
    name: string;
    enabled?: boolean;
    schedule: {
        kind: 'minutes';
        everyMinutes: number;
    } | {
        kind: 'hourly';
        minute: number;
    } | {
        kind: 'daily';
        time: string;
    };
    /** 显式点名的源 id 集（空=全部启用源；stream 源只能这样进快报） */
    sourceIds?: string[];
    keywords?: string[];
    minScore?: number;
    maxItems?: number;
    focus?: string;
}
//# sourceMappingURL=methods.d.ts.map