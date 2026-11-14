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
    runDigest: (force?: boolean, day?: string, opts?: {
        peakBypass?: boolean;
    }) => Promise<unknown>;
    /** 宿主 LLM runtime（可选能力）；用于 /api/llm 列 provider/model */
    getLlm?: () => {
        listProviders(): Array<{
            id: string;
        }>;
        listModels(p: string): Promise<Array<{
            id: string;
        }>>;
    } | undefined;
    /** 宿主目录选择服务（可选能力）；native 能力弹系统对话框，browse/缺失时 pick-dir 返回 supported:false */
    getDirectoryPicker?: () => {
        capability?: () => {
            kind?: string;
            pick?: (s: AbortSignal) => Promise<string | null>;
        };
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
    /** 开发日志目录（prefs.devLog 开启时 LLM 全量对话 JSONL 落这里） */
    devlogDir?: string;
    /** 页面活跃心跳：每个 API/静态请求都打一下——无心跳=页面已关（statusbar 2s 轮询天然是心跳） */
    onApiHit?: () => void;
    /** 用户真实手势信号：前端只在最近 60s 内有鼠标/键盘/滚动/触屏交互时在 status 轮询上带 act=1——区分"页面挂机"和"人在用" */
    onGesture?: () => void;
    /** 启动时间线打点（devlog/boot.log）——定位冷启动占位屏的真实空档 */
    bootMark?: (mark: string) => void;
    /** 内置「时段快报」种子参数（svc.listBriefTypes 缺失时的回落——测试挂载可省略） */
    briefDefaults?: {
        enabled: boolean;
        minScore: number;
    };
}
/** 注册阅读器全部路由；返回 disposer。MOUNT 于 ctx.inject(['webServer']) 内调用。 */
export declare function mountApi(ws: WebServerLike, deps: ApiDeps): () => void;
export {};
//# sourceMappingURL=api.d.ts.map