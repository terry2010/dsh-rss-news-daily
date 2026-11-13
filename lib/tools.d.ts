/** ctx.tools 注册：news_* 前缀防撞名。值即契约 + render 投影。 */
import type { Context } from '@deepseek-ai/cordis';
import type { FeedSource, FetchCycleResult } from './core/types.js';
import type { TopicParams } from './topic-pipeline.js';
/** LLM 全局队列快照（llmQueueSnapshot 投影）：tagRunning/tagQueued 是本任务口径，tagAhead 是前方调用数 */
export interface LlmQueueInfo {
    limit: number;
    running: number;
    queued: number;
    tagRunning: number;
    tagQueued: number;
    tagAhead: number;
    /** 本任务排队中的调用 purpose 列表 */
    mineQueued: string[];
    /** 前方调用 purpose 明细（在飞的他人调用 + 队列里排在前面的） */
    ahead: string[];
}
/** 插件对外操作的统一门面（index.ts 注入，避免 tools.ts 直接绑 store） */
export interface NewsService {
    listSources(): FeedSource[];
    addSource(opts: {
        url: string;
        title?: string;
        category?: string;
    }): Promise<FeedSource>;
    previewSource?(opts: {
        url: string;
        title?: string;
        category?: string;
    }): Promise<{
        url: string;
        title: string;
        category?: string;
        viaProxy: boolean;
        items: {
            title: string;
            link: string;
        }[];
    }>;
    setEnabled(urlOrId: string, enabled: boolean): Promise<void>;
    setSummarize(urlOrId: string, summarize: boolean): Promise<void>;
    removeSource(urlOrId: string): Promise<boolean>;
    restoreSource?(url: string): Promise<boolean>;
    importOpml(opmlText: string): Promise<{
        added: number;
        duplicated: number;
        skipped: number;
        details?: Array<{
            url: string;
            action: string;
            reason?: string;
        }>;
    }>;
    exportOpml(): Promise<string>;
    runFetch(force?: boolean, onlyFailed?: boolean, filter?: {
        source?: string;
        category?: string;
    }): Promise<FetchCycleResult>;
    /** 抓取进度（{running,done,total,cancelled,etaMs?,queue?,queued?,taskWaiting?}），供 UI 轮询 */
    fetchProgress?(): Promise<{
        running: boolean;
        done: number;
        total: number;
        cancelled?: boolean;
        etaMs?: number;
        queue?: LlmQueueInfo;
        queued?: boolean;
        taskWaiting?: number;
    }>;
    /** 中止进行中的抓取 */
    cancelFetch?(): Promise<unknown>;
    /** 翻译条目（标题+摘要→中文），结果写 item.state.translation */
    translateItem?(id: string): Promise<{
        ok: boolean;
        translation?: string;
        error?: string;
    }>;
    /** 日报生成进度（{running,done,total,cancelled,etaMs?,queue?,queued?,taskWaiting?}），供 UI 轮询 */
    digestProgress?(): Promise<{
        running: boolean;
        done: number;
        total: number;
        cancelled?: boolean;
        etaMs?: number;
        queue?: LlmQueueInfo;
        queued?: boolean;
        taskWaiting?: number;
    }>;
    /** 连通性测试：真实 fetcher 路径抓 url，返回 status/body 片段（验证出口/代理） */
    testFetch?(url: string, proxy?: string | boolean): Promise<{
        status?: number;
        body?: string;
        error?: string;
    }>;
    status(): {
        sources: number;
        enabled: number;
        items: number;
        lastFetchAt: string;
        lastDigestDay: string;
        failures: Array<{
            name: string;
            error: string;
        }>;
    };
    tune(text: string): Promise<{
        ok: boolean;
        actions: string[];
        error?: string;
    }>;
    getDigest(day?: string): Promise<{
        ok: boolean;
        day: string;
        markdown?: string;
        error?: string;
    }>;
    regenDigest(force: boolean): Promise<{
        ok: boolean;
        items?: number;
        degraded?: boolean;
        error?: string;
    }>;
    searchItems(q: string, limit?: number): Array<{
        id: string;
        title: string;
        link: string;
        topic: string;
        fetchedAt: string;
        digestedDay: string;
    }>;
    feedback(id: string, action: string): Promise<{
        ok: boolean;
        learned?: string[];
        error?: string;
    }>;
    retrySource(urlOrId: string): Promise<boolean>;
    /** 编辑源属性（title/category/enabled/summarize/proxy/cooldownHours） */
    updateSource(urlOrId: string, patch: Record<string, unknown>): Promise<unknown>;
    /** 无效名单变更后回扫存量：命中名单的短正文条目置 hidden；返回新隐藏数 */
    rescanStubContent?(): Promise<number>;
    /** 中止进行中的日报生成（LLM 流逐条失败→降级收尾） */
    stopDigest?(): Promise<unknown>;
    /** AI 专题：候选预览（只读，不调 LLM，不受生成锁限制） */
    previewTopic?(params: TopicParams, page?: number, filterSourceId?: string): Promise<{
        hitCount: number;
        dedupCount: number;
        capCount: number;
        filterCount: number;
        page: number;
        pageCount: number;
        sources: Array<Record<string, unknown>>;
        items: Array<Record<string, unknown>>;
    }>;
    /** AI 专题：启动生成（落 queued 元数据进全局任务队列；拿到槽位才翻 generating 发射） */
    runTopic?(params: TopicParams): Promise<{
        ok: boolean;
        id?: string;
        queued?: boolean;
        error?: string;
    }>;
    /** AI 专题：同参覆盖重生成（仅 done/error；generating/queued 行禁用；统一排队） */
    regenTopic?(id: string): Promise<{
        ok: boolean;
        id?: string;
        queued?: boolean;
        error?: string;
    }>;
    /** AI 专题生成进度（{running,done,total,stage,id,etaMs?,queue?,queuedIds?,taskWaiting?}），供 UI 轮询与懒修复排除 */
    topicProgress?(): Promise<{
        running: boolean;
        done: number;
        total: number;
        stage?: string;
        id?: string;
        etaMs?: number;
        queue?: LlmQueueInfo;
        queuedIds?: string[];
        taskWaiting?: number;
    }>;
    /** 中止专题：id 命中排队项→撤队落 error；命中在跑（或不带 id）→abort 在飞调用 */
    stopTopic?(id?: string): Promise<unknown>;
    /** 把排队中的专题从内存队列摘除（删除接口用——不动 meta） */
    dequeueTopic?(id: string): boolean;
    /** 全局任务队列快照：{limit,running[],waiting[]}——悬停提示渲染全部任务+逐项取消 */
    taskList?(): Promise<{
        limit: number;
        running: Array<{
            id: string;
            kind: string;
            label: string;
            stage?: string;
            done?: number;
            total?: number;
            etaMs?: number;
        }>;
        waiting: Array<{
            id: string;
            kind: string;
            label: string;
            position: number;
        }>;
    }>;
    /** 按任务 id 取消：'fetch'/'digest'/'topic:{metaId}'——waiting 撤队，running abort */
    cancelTask?(id: string): Promise<{
        ok: boolean;
        cancelled?: 'waiting' | 'running';
    }>;
}
/** 注册全部 news_* 工具；返回 disposer。 */
export declare function registerTools(ctx: Context, svc: NewsService): () => void;
//# sourceMappingURL=tools.d.ts.map