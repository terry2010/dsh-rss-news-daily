/**
 * webServer 路由：静态阅读器 /dsh-rss-news-daily/ + /api/* JSON 端点。
 * 全部 handler 是原生 req/res；sendJson 统一响应。同源检查拦 cross-site。
 */
import type { StoreLike } from './core/store.js';
import type { PrefsStore } from './core/prefs.js';
import type { NewsService } from './tools.js';
interface Req {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
    on(ev: string, cb: (c?: unknown) => void): void;
}
interface Res {
    statusCode: number;
    setHeader(k: string, v: string): void;
    end(b?: string): void;
}
interface WebServerLike {
    register(opts: {
        kind: string;
        path: string;
        handler: (req: Req, res: Res) => void;
    }): () => void;
}
export interface ApiDeps {
    store: StoreLike;
    prefs: PrefsStore;
    svc: NewsService;
    configSources: Array<{
        url: string;
        title?: string;
        category?: string;
        enabled?: boolean;
    }>;
    timezone: string;
    readerPageSize: number;
    digestsDir: string;
    runDigest: (force?: boolean, day?: string) => Promise<unknown>;
    /** 宿主 LLM runtime（可选能力）；用于 /api/llm 列 provider/model */
    getLlm?: () => {
        listProviders(): Array<{
            id: string;
        }>;
        listModels(p: string): Promise<Array<{
            id: string;
        }>>;
    } | undefined;
    /** config 层的 llm 路由对（用于 effective 判定展示） */
    configLlm?: {
        provider: string;
        model: string;
    };
    /** config 层的调度默认（UI 覆盖的回落） */
    configSchedule?: {
        digestTimes: string[];
        fetchTimes: string[];
    };
}
/** 注册阅读器全部路由；返回 disposer。MOUNT 于 ctx.inject(['webServer']) 内调用。 */
export declare function mountApi(ws: WebServerLike, deps: ApiDeps): () => void;
export {};
//# sourceMappingURL=api.d.ts.map