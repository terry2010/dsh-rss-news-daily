/**
 * 高峰时段判定：每日 [start, end) 窗口（config.timezone 口径，与调度表同时区）。
 * 支持跨零点窗口（如 22:00–06:00）；start==end 视为未配置。
 * 纯模块：所有判定给定 now 即确定，可直接单测。
 */
export interface PeakRange {
    /** 'HH:MM' */
    start: string;
    /** 'HH:MM' */
    end: string;
}
/** start/end 都合法且不相等才算有效窗口（相等按未配置处理，防误填 00:00–00:00 封死全天） */
export declare function peakRangeValid(range: PeakRange | undefined): boolean;
/** 当前是否处于高峰窗口内 */
export declare function isPeak(now: Date, range: PeakRange | undefined, timezone?: string): boolean;
/** 下一次窗口边界（进峰或出峰）的 UTC 时刻；无效窗口返回 undefined。
 *  进峰/出峰两类边界合并取近者：start 与 end 各自的下一次出现时刻取 min。 */
export declare function nextPeakTransition(now: Date, range: PeakRange | undefined, timezone?: string): Date | undefined;
/** 「排低峰队列」快报的槽位窗口：start=入队时最近一轮抓取起点（槽内容=那批条目）；
 *  超 staleMs 无抓取说明没有"当前这批"——槽=此刻（快报自然为空时段）。end=入队时刻：
 *  之后峰内抓的批次归各自的槽，不进本节。 */
export declare function slotBriefWindow(lastFetchIso: string | undefined, nowIso: string, staleMs?: number): {
    start: string;
    end: string;
};
//# sourceMappingURL=peak.d.ts.map