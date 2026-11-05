/**
 * 调度：抓取轮询 + 每日日报锚点 + 启动补跑，基于 timer 服务的 ctx.timeout/interval。
 * 每日定时器每次跑完重新计算下一个墙钟时刻（nextZonedOccurrence），
 * 对重启/漂移/DST 都稳。
 */
import type { FetchSectionConfig } from './config.js';
import type { FetchCycleResult, LogSink } from './core/types.js';
export interface SchedulerOptions {
    fetch: FetchSectionConfig;
    /** 每日日报配置（digest.enabled 用 llm/summary 不相关，这里只要时间与补跑窗口） */
    dailyTime: string;
    timezone: string;
    catchUpHours: number;
    enabled: boolean;
    /** 已生成日报的最近日期（YYYY-MM-DD，来自 store.meta.lastDigestDay） */
    lastDigestDay: () => string;
    runFetchCycle: (signal?: AbortSignal) => Promise<FetchCycleResult>;
    runDailyDigest: () => Promise<unknown>;
    /** 生效时间表：digestTimes 空则回落 [dailyTime]；每次 arm 时重读（UI 改动下一跳生效） */
    getSchedule?: () => {
        digestTimes: string[];
        fetchTimes: string[];
    };
    log?: LogSink;
}
/** timer 服务挂到 ctx 上的接缝（ctx.timeout/ctx.interval）——类型上 Context 不声明它，用结构类型接。 */
export interface TimerSeam {
    timeout(fn: () => void, ms: number): () => void;
    interval(fn: () => void, ms: number): () => void;
}
/** 装配全部周期任务；返回 disposer。 */
export declare function startScheduler(ctx: TimerSeam, options: SchedulerOptions): () => void;
//# sourceMappingURL=scheduler.d.ts.map