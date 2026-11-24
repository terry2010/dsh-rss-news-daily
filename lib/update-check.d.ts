/**
 * 每日更新检查：启动 delayMinutes 后向 update 端点上报一次自身版本 +
 * 已安装伴随插件版本，拉回最新升级信息；每个自然日最多一次（成败都计）。
 *
 * 隐私口径（docs 详设 §2.4）：上行 {pkg, version, companions} + iid/d/t——
 * iid 是首跑生成的随机 uuid 安装标识（统计去重用，无机器信息），d 是上报日，
 * t 是绑定这些字段的 HMAC 签名（防污染，非安全边界）；无 OS/UA 指纹
 * （UA 仅 pkg/version 自身）。端点非 https 直接拒跑（防降级伪造更新信息）。
 *
 * 伴随插件版本来源：profile 清单 package.json 的 dependencies（cordis
 * registry 只有插件名没有版本）。manifest 定位 = 从自身模块路径向上找第一
 * 个含 dsh.profile.bundles 的 package.json；找不到回退扫 DSH_HOME/profiles。
 * file: spec（dev 安装）跟随读真实版本。
 *
 * fetch/fs/clock 全注入，纯逻辑可测。
 */
import type { TimerSeam } from './scheduler.js';
import type { LogSink } from './core/types.js';
/** 上行 payload —— 用户定稿的最小集，勿加字段（隐私口径）。 */
export interface UpdateReport {
    pkg: string;
    version: string;
    companions: Record<string, string>;
}
/** 下行响应（服务端 latest.json 消毒后形状）。 */
export interface UpdateInfo {
    latest: string;
    url?: string;
    notes?: string;
    minSupported?: string;
    companions?: Record<string, {
        latest: string;
        url?: string;
    }>;
}
/** store.meta.updateCheck 台账形状（StoreMeta 同步定义于 core/store.ts）。 */
export interface UpdateCheckState {
    /** 当天已尝试过的判据——成败都记，"每天只检查一次"优先于"不漏检查" */
    lastAttemptDay: string;
    /** 持久随机安装标识（uuid，首跑生成）——统计去重用，无机器信息 */
    installId?: string;
    lastCheckedAt?: string;
    latest?: string;
    hasUpdate?: boolean;
    url?: string;
    notes?: string;
}
/** 宽松 semver 比较：x[.y[.z]][-prerelease]。返回 -1|0|1。预发版 < 同号正式版。 */
export declare function compareSemver(a: string, b: string): number;
/** 从 manifest dependencies 筛伴随插件：dsh-rss-news-* 前缀且 ≠ 自身。
 *  file: spec 交给 resolver 还原真实版本；还原不了就报 spec 字面量（如实上报）。 */
export declare function companionVersions(deps: Record<string, string>, selfPkg: string, resolveFileVer?: (spec: string) => string | undefined): Record<string, string>;
interface ProfileManifest {
    deps: Record<string, string>;
    dir: string;
}
/** manifest 定位主路径：从插件自身安装位置逐级向上，找含 dsh.profile.bundles
 *  （且 bundles 含本包）的 package.json——即当前运行 profile 的根。 */
export declare function findProfileDeps(fromDir: string, selfPkg: string): ProfileManifest | undefined;
/** 回退：dev link 等场景向上找不到时，扫 <dshHome>/profiles/*\/package.json，
 *  取第一个 bundles 含本包的 profile（确定性：目录名排序）。 */
export declare function scanProfileDeps(dshHome: string, selfPkg: string): ProfileManifest | undefined;
/** 汇总：manifest 定位（向上→扫 profiles）→ file: 还原 → 伴随表。 */
export declare function listCompanions(selfPkg: string, opts?: {
    fromDir?: string;
    dshHome?: string;
}): Record<string, string>;
/** 响应消毒：shape 不对/字段类型不对 → null（服务端被劫持也只能拿到"无更新"）。 */
export declare function sanitizeUpdateInfo(v: unknown): UpdateInfo | null;
/** 上报签名：hmac(v1|iid|day|pkg|version|companionsJson)[:16hex] → "v1.<sig>"
 *  服务端 recompute 校验——篡改任一字段签名即失效（统计防污染，非安全边界）。 */
export declare function reportToken(opts: {
    iid: string;
    day: string;
    pkg: string;
    version: string;
    companionsJson: string;
    key?: string;
}): string;
/** 打一次端点；任何失败/异常 → null（调用方只 log，不阻断主流程）。
 *  上报走 GET query——服务端是纯静态 nginx，access_log 即数据管线。 */
export declare function runUpdateCheck(opts: {
    endpoint: string;
    timeoutMs: number;
    report: UpdateReport;
    /** 持久随机安装标识（uuid）；给了才会带 iid/d/t 签名三参 */
    installId?: string;
    /** 上报日（调用方本地时区口径），签名内绑定防改 */
    day?: string;
    fetchImpl?: typeof fetch;
    log?: LogSink;
}): Promise<UpdateInfo | null>;
export interface StartUpdateCheckOpts {
    enabled: () => boolean;
    endpoint: () => string;
    delayMs: number;
    timeoutMs: number;
    timezone?: string;
    selfPkg: string;
    selfVer: string;
    companions: () => Record<string, string>;
    /** 可写 meta 对象（两后端 get meta() 都返回引用，直接改 + save 即持久化） */
    meta: () => {
        updateCheck?: UpdateCheckState;
    };
    save: () => void;
    /** 发现新版本时的回调（系统通知等），url 可空 */
    onUpdate?: (info: UpdateInfo) => void;
    now?: () => Date;
    fetchImpl?: typeof fetch;
    log?: LogSink;
}
/** 装配启动延迟定时器；返回 disposer（插件重载清钟用）。 */
export declare function startUpdateCheck(timer: TimerSeam, opts: StartUpdateCheckOpts): () => void;
export {};
//# sourceMappingURL=update-check.d.ts.map