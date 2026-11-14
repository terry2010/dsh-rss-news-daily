/**
 * 快报类型（brief types）：可增删改的"今日快报列表"生产者。
 *
 * 纯模块：类型定义/prefs 消毒/内置默认解析/槽位调度数学/文件路径/合并视图组装。
 * 被 index.ts（调度+生成）、api.ts（CRUD+读取）、prefs.ts（normalize）共用。
 *
 * 存储布局：
 *  - 内置类型 id='hourly'（builtin）→ `{day}-hourly.md`（历史路径与节格式不变，`## HH:mm 时段快报`）
 *  - 自定义类型 → `digests/briefs/{day}-{id}.md`，节 `## HH:mm {name}`
 * 节名自带类型名 → 「全部」合并视图把各文件切成 ## 节按时倒序拼接即可，无需隐藏标记。
 *
 * 槽位语义（schedule）：
 *  - minutes：距上次运行 ≥ everyMinutes 即到期；从未跑过立即到期
 *  - hourly：每个整点槽 :MM——lastRun < 本槽起点即到期（错过的槽不补，只跑当前槽）
 *  - daily：今日 HH:mm 槽——同理只跑今日槽（当日错过→首次到达即补，跨日不补历史槽）
 */
export type BriefSchedule = {
    kind: 'minutes';
    everyMinutes: number;
} | {
    kind: 'hourly';
    minute: number;
} | {
    kind: 'daily';
    time: string;
};
export interface BriefType {
    id: string;
    name: string;
    /** false=停用（保留配置不出快报） */
    enabled: boolean;
    /** 内置默认类型（时段快报）：id='hourly'，写历史文件路径 */
    builtin?: boolean;
    schedule: BriefSchedule;
    /** 使用新闻源 id 集；空=全部启用源 */
    sourceIds: string[];
    /** 筛选关键字（标题/摘要任一命中 OR）；空=不筛 */
    keywords: string[];
    /** 入选最低评分（llmScore ?? 启发式兜底键） */
    minScore: number;
    /** 入文条数上限；0=不限 */
    maxItems: number;
    /** 快报重点：注入概括 prompt 的侧重说明；空=通用概括 */
    focus: string;
}
/** 单条消毒：id/schedule 非法整条丢弃，其余字段畸形回默认。 */
export declare function normalizeBriefType(v: unknown): BriefType | undefined;
/** 数组消毒：非法条目剔除；[] 保持 []（用户删光=真的没有类型）。 */
export declare function normalizeBriefTypes(v: unknown): BriefType[] | undefined;
export interface BriefDefaults {
    /** 旧 hourlyBrief 开关作种子 */
    enabled: boolean;
    /** 旧 hourlyMinScore 作种子 */
    minScore: number;
}
/** 内置默认类型：现有「时段快报」语义等价迁移（写 `{day}-hourly.md`）——每个整点槽 :00 */
export declare function builtinBriefType(def: BriefDefaults): BriefType;
/** prefs.briefTypes 未配置时返回内置默认（「现有的时段快报默认填进去」）；配置过即按表返回。 */
export declare function resolveBriefTypes(prefs: {
    briefTypes?: unknown;
}, def: BriefDefaults): BriefType[];
export declare function newBriefTypeId(): string;
/** UI 频率文案 */
export declare function briefScheduleText(t: BriefType): string;
export declare const briefsDirOf: (digestsDir: string) => string;
/** 类型当日的快报文件：内置写历史路径，自定义写 briefs/ 子目录 */
export declare function briefFileOf(digestsDir: string, type: {
    id: string;
    builtin?: boolean;
}, day: string): string;
/** 读取侧按 key 定位（不问 prefs——已删类型的历史文件照样可读） */
export declare function briefFileFor(digestsDir: string, typeKey: string, day: string): string;
/** 当前槽是否未被 lastRun 覆盖（=该跑）。lastRun 是 ISO 时刻（store.meta.briefRuns[id]）。 */
export declare function briefDue(t: BriefType, lastRunIso: string | undefined, now: Date, timezone?: string): boolean;
/** 距下次该跑的毫秒数（到期=0）。调度器取全部启用类型的最小值挂钟。 */
export declare function nextBriefMs(t: BriefType, lastRunIso: string | undefined, now: Date, timezone?: string): number;
/** 类型本次运行的候选窗口起点（ISO）：有 lastRun 取 max(lastRun, 今日0点)，从未跑过取今日0点（首跑覆盖全天）。 */
export declare function briefWindowStart(lastRunIso: string | undefined, dayStartIso: string): string;
/** 「今日快报列表-全部」：各类型文件体切成 `## HH:mm <名>` 节，按时刻倒序拼成一篇。无节返回 undefined。 */
export declare function mergeBriefMarkdown(day: string, bodies: string[]): string | undefined;
/** 前端列表行辅助（API 不直接用） */
export declare function briefDayOf(now: Date, timezone?: string): string;
//# sourceMappingURL=brief-types.d.ts.map