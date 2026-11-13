/**
 * prefs.json 读写：用户偏好权重（topics/keywords/bannedKeywords/sourceWeight）。
 * M3 提供读写与消毒；M5 的 news_tune/反馈学习在此基础上增改权重。
 */
import type { Prefs } from './scorer.js';
import type { LogSink } from './types.js';
export interface PrefsFile extends Prefs {
    /** 调教历史（M5 写入）：{at, text, actions[]} */
    tuningHistory?: Array<{
        at: string;
        text: string;
        actions: string[];
    }>;
    /** UI 指定的日报模型覆盖；两个都非空才生效（成对校验同 config） */
    llm?: {
        provider: string;
        model: string;
    };
    /** UI 指定的多时间点调度覆盖；digestTimes 空=回 dailyTime */
    schedule?: {
        digestTimes: string[];
        fetchTimes: string[];
        intervalMinutes?: number;
        onStartup?: boolean;
    };
    /** UI 全局代理 URL（fetcher 每次解析：UI 覆盖 > config.fetch.proxyUrl > 环境变量） */
    proxyUrl?: string;
    /** 抓取后自动翻译所有外文条目（按条调翻译模型，成本高） */
    autoTranslate?: boolean;
    /** 工作区导航显示「新闻」入口（缺省=显示；false=隐藏 guide 条目） */
    showNavEntry?: boolean;
    /** 用 dsh-loop-recover 过滤模型输出（缺省=装了自动开） */
    loopGuard?: boolean;
    /** 定时备份：周期 + 目录 + 保留份数 */
    backup?: {
        enabled?: boolean;
        period?: 'day' | 'week' | 'month';
        dir?: string;
        keep?: number;
    };
    /** 开发日志：完整记录每次模型调用的 prompt/回复、token 用量与生成速度（devlog/ 目录 JSONL） */
    devLog?: boolean;
    /** UI 翻译模型覆盖（独立于日报模型 llm） */
    translateLlm?: {
        provider: string;
        model: string;
    };
    /** 订阅分类列表（缺省/未设=全部订阅） */
    subscribedTopics?: string[];
    /** 新快报生成时发桌面通知（缺省=关；macOS 点击可打开快报，其余平台仅展示） */
    notifyDesktop?: boolean;
    /** UI 日报参数覆盖；单字段未设=跟随 cordis config 默认 */
    digestOpts?: {
        digestItems?: number;
        perTopicLimit?: number;
        minLlmScore?: number;
        candidateHours?: number;
        llmScoreCandidates?: number;
        summaryMaxItems?: number;
        summaryConcurrency?: number;
        digestMaxLength?: number;
        scoreOnFetch?: boolean;
        rescoreMissing?: boolean;
        hourlyBrief?: boolean;
        retentionDays?: number;
        pruneLowQuality?: boolean;
        storeMaxItems?: number;
    };
    /** 阅读字号缩放（1=默认）。global=设置页统一值；items/digest/hourly/topics=各页 A−A＋ 分项值；分项优先于 global */
    fontSize?: {
        global?: number;
        items?: number;
        digest?: number;
        hourly?: number;
        topics?: number;
    };
    /** 适应宽屏：items=全部新闻页、digest=今日精选页（日报/快报/专题共用）；默认开——显式 false 才回 880px 窄版 */
    wide?: {
        items?: boolean;
        digest?: boolean;
    };
    /** 全局 AI 调用并发数（所有模型调用共用一个信号量；1=全串行，本地弱模型建议 1；1-8） */
    llmConcurrency?: number;
    /** 无效正文名单：入库新闻正文命中即整条隐藏（归一化等值匹配）；AI 判定无效的短正文自动追加 */
    contentBlocklist?: string[];
    /** 短正文判定阈值（汉字数/英文词数双口径，低于即进名单匹配+AI 判定；缺省 15/10） */
    stubLimits?: {
        zh?: number;
        en?: number;
    };
}
/** 把未知输入消毒成 PrefsFile；畸形字段回默认，不抛错。 */
export declare function normalizePrefs(value: unknown): PrefsFile;
/** prefs.json 的内存门面：load 一次，get() 取当前值，set/save 持久化。 */
export declare class PrefsStore {
    readonly path: string;
    private prefs;
    private readonly log;
    constructor(path: string, log?: LogSink);
    load(): void;
    get(): PrefsFile;
    /** 覆盖写（原子 tmp+rename）。 */
    save(next?: Partial<PrefsFile>): void;
    /** 追加一条调教历史并立即生效一组权重改动（M5 用）。 */
    applyTune(text: string, actions: string[], patch: Partial<Prefs>): void;
}
//# sourceMappingURL=prefs.d.ts.map