/** ctx.tools 注册：news_* 前缀防撞名。值即契约 + render 投影。 */
import type { Context } from '@deepseek-ai/cordis';
import type { FeedSource, FetchCycleResult } from './core/types.js';
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
    /** 抓取进度（{running,done,total,cancelled}），供 UI 轮询 */
    fetchProgress?(): Promise<{
        running: boolean;
        done: number;
        total: number;
        cancelled?: boolean;
    }>;
    /** 中止进行中的抓取 */
    cancelFetch?(): Promise<unknown>;
    /** 翻译条目（标题+摘要→中文），结果写 item.state.translation */
    translateItem?(id: string): Promise<{
        ok: boolean;
        translation?: string;
        error?: string;
    }>;
    /** 日报生成进度（{running,done,total,cancelled}），供 UI 轮询 */
    digestProgress?(): Promise<{
        running: boolean;
        done: number;
        total: number;
        cancelled?: boolean;
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
    /** 中止进行中的日报生成（LLM 流逐条失败→降级收尾） */
    stopDigest?(): Promise<unknown>;
}
/** 注册全部 news_* 工具；返回 disposer。 */
export declare function registerTools(ctx: Context, svc: NewsService): () => void;
//# sourceMappingURL=tools.d.ts.map