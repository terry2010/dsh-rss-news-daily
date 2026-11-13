/**
 * AI 专题管线：候选筛选 → 两级去重 → 分批小结 → 合并成文 → 起名 → [N] 引用解析 → 落盘+索引。
 *
 * 与日报同铁律：任意一次 LLM 失败只降级该处，专题永远产出（抽取式兜底）。
 * 纯模块：node:fs/node:path 之外无宿主依赖；LLM 经注入的 LlmClient。
 */
import type { FeedItem, LogSink } from './core/types.js';
import type { LlmClient } from './summarizer.js';
export interface TopicParams {
    keywords: string[];
    /** YYYY-MM-DD 本地日（含当日全天）；空=不限 */
    from: string;
    to: string;
    /** 空数组=全部源 */
    sourceIds: string[];
    /** 专题重点/方向（拼进各批与合并 prompt） */
    focus: string;
    /** 0=不限；白名单 3/5/7/8 */
    minScore: number;
    /** 入文条数上限；白名单 50/100/200/500 */
    maxItems: number;
}
export interface TopicMeta {
    id: string;
    title: string;
    keywords: string[];
    from: string;
    to: string;
    sourceIds: string[];
    focus: string;
    minScore: number;
    maxItems: number;
    createdAt: string;
    updatedAt: string;
    /** 去重前命中（关键词并集按 id 去重后） */
    hitCount: number;
    /** 两级去重后候选数 */
    dedupCount: number;
    /** 入文条数（编号 1..itemCount） */
    itemCount: number;
    /** 正文实际引用的条目数 */
    usedCount: number;
    durationMs: number;
    degraded: boolean;
    excerpt: string;
    status: 'generating' | 'queued' | 'done' | 'error';
    error?: string;
}
/** API 入参归一化；缺省补默认，白名单外值返回 400 文案。 */
export declare function normalizeTopicParams(body: unknown): {
    ok: true;
    params: TopicParams;
} | {
    ok: false;
    error: string;
};
export declare function newTopicId(): string;
/** 专题候选需要的最小 store 面（SqliteStore.queryItems 的 subset） */
export interface TopicItemStore {
    queryItems(opts: {
        q?: string;
        sources?: string[];
        publishedAfter?: string;
        publishedBefore?: string;
        minScore?: number;
        sort?: 'published' | 'fetched';
        page?: number;
        pageSize?: number;
    }): {
        total: number;
        items: FeedItem[];
    };
}
/** 展示分口径：llmScore 优先，缺省启发式分换算（与 pickFinal/SQL 下推同式） */
export declare const topicKeyOf: (i: FeedItem) => number;
export interface TopicCandidates {
    /** 关键词并集（按 id 去重后）命中数 */
    hitCount: number;
    /** 两级去重后候选数 */
    dedupCount: number;
    /** 最终入文（cap 后），顺序即全局编号 1..N */
    items: FeedItem[];
}
export declare function queryTopicCandidates(store: TopicItemStore, params: TopicParams, timezone?: string): TopicCandidates;
/** 正文中 [N] 解析：合法→紧凑编号链接 [N](url) 并入 usedSet（参考区同编号对应）；越界/畸形→整个标记丢弃（不猜）。
 * 注意不替换成 [标题](url)：一句多引时正文会被长标题+长链接砸烂——编号即引用，参考区才是完整清单。 */
export declare function parseTopicCitations(text: string, items: FeedItem[]): {
    text: string;
    used: FeedItem[];
};
/** meta.excerpt：取「概述」节纯文本 ~120 字；无该节取正文开头 */
export declare function topicExcerpt(body: string): string;
/** LLM 标题消毒：取首行、去 markdown/标点壳、截断；空→''（调用方回退关键词） */
export declare function sanitizeTopicTitle(raw: string): string;
export interface TopicRenderInput {
    title: string;
    keywords: string[];
    from: string;
    to: string;
    focus: string;
    hitCount: number;
    dedupCount: number;
    itemCount: number;
    usedItems: FeedItem[];
    /** 全部入文（usedItems 编号引用用） */
    items: FeedItem[];
    sourcesById: Map<string, {
        title: string;
    }>;
    body: string;
    createdAt: string;
    durationMs: number;
    degraded: boolean;
}
/** 超长段落重排：模型常把整节/整条写成一行（实测 1300+ 字一段、1100+ 字单条 bullet），按中文句读边界切成 ≤420 字。
 * 正文行切段（段间空行）；超长 - 列表项拆成多条 bullet（条间不换空行）。切点要求行内 ** 与 * 标记成对闭合，不切断行内标记。 */
export declare function reflowTopicBody(body: string): string;
/** 程序渲染首尾：H1+meta 引用块+参考新闻+页脚；LLM 只写中间 sections。 */
export declare function renderTopic(o: TopicRenderInput): string;
export declare function topicsDirOf(digestsDir: string): string;
export declare function readTopicsIndex(digestsDir: string): Promise<TopicMeta[]>;
export declare function writeTopicsIndex(digestsDir: string, topics: TopicMeta[]): Promise<void>;
export declare function upsertTopicMeta(digestsDir: string, meta: TopicMeta): Promise<void>;
/** 列表读取：activeId 之外的 generating、queuedIds 之外的 queued 一律懒修复为 error（进程重启中断；队列是内存态，重启即丢） */
export declare function listTopics(digestsDir: string, opts?: {
    activeId?: string;
    queuedIds?: string[];
}): Promise<TopicMeta[]>;
export declare function deleteTopic(digestsDir: string, id: string): Promise<boolean>;
/** 导出文件名消毒：去路径分隔/控制符/markdown 壳，60 字截断 */
export declare function safeFileStem(s: string): string;
export declare function exportTopic(digestsDir: string, id: string, dir: string): Promise<string>;
export interface TopicPipelineOptions {
    store: TopicItemStore;
    params: TopicParams;
    /** 已落盘的 generating 元数据（id/createdAt 已定）；本函数就地更新到 done */
    meta: TopicMeta;
    llmClient?: LlmClient;
    llmEnabled: boolean;
    /** 批小结 worker 数（实际并发受全局信号量约束） */
    summaryConcurrency: number;
    llmTimeoutMs: number;
    llmMaxTokens: number;
    /** 外部取消信号（停止按钮/进程恢复） */
    signal?: AbortSignal;
    sourcesById: Map<string, {
        title: string;
    }>;
    digestsDir: string;
    timezone?: string;
    log?: LogSink;
    /** done/total=已完成批数；stage: candidates|chunks|finishing */
    onProgress?: (done: number, total: number, stage: string) => void;
}
export declare function runTopicPipeline(opts: TopicPipelineOptions): Promise<TopicMeta>;
//# sourceMappingURL=topic-pipeline.d.ts.map