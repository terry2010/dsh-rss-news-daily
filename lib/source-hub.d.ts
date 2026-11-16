/**
 * rndSources 服务：伴随插件的公开注册面。
 *
 * 伴随插件 `export const inject = ['rndSources']` 后在本服务上可做五件事：
 *   - registerMethod('<包名>:<方法>', handler)  注册非标抓取 handler
 *   - addSources('<包名>', defs)                注入源定义（provider 落源上，卸载可识别）
 *   - registerBriefType('<包名>', def)          注册快报类型（id 冲突时用户已存配置优先）
 *   - registerView('<包名>', view)              给阅读器顶部贡献 iframe tab（页挂自己 webServer 路由）
 *   - notify(title, body, path)                 请求桌面通知（与快报同一通道；path=点击打开的阅读器路径）
 *   - removeSources(provider)                   清掉自己注入过的源及其条目（伴随插件转向独立存储时的卸载通道）
 *
 * 调度/解析/去重/健康度/存储/日报管线全部归主插件——伴随插件只「给数据」。
 * 公开 API 面，签名进 semver；apiVersion 供伴随插件首行检查。
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { MethodHandler, SourceDef, ViewDef, BriefTypeDef } from './core/methods.js';
import { type BriefType } from './brief-types.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        rndSources: RndSourceHub;
    }
}
export interface RegisteredView extends ViewDef {
    provider: string;
}
/** 对外注册面：伴随插件只摸这几个方法。公开 API，进 semver。 */
export declare class RndSourceHub extends Service {
    private readonly addSourcesImpl;
    private readonly removeSourcesImpl?;
    /** 伴随插件首行检查：`if (ctx.rndSources.apiVersion < 1) return` */
    readonly apiVersion = 1;
    private readonly views;
    private readonly briefTypes;
    private notifier?;
    constructor(ctx: Context, addSourcesImpl: (provider: string, defs: SourceDef[]) => void, removeSourcesImpl?: ((provider: string) => Promise<number>) | undefined);
    /** 注册非标抓取 handler。命名约定 '<包名>:<方法>'；重名拒绝（防两个伴随插件互相覆盖）。 */
    registerMethod(name: string, handler: MethodHandler): void;
    /** provider = 调用方插件 id（传自己的 export const name）——卸载后遗留源可识别/禁用/清理 */
    addSources(provider: string, defs: SourceDef[]): void;
    /**
     * 删除 provider 名下的全部源及其条目（幂等）。
     * 伴随插件从「注入主库」转向「独立存储」时调用，把历史数据从主库清干净。
     * 返回删除的源数；主插件未注入实现时返回 0。
     */
    removeSources(provider: string): Promise<number>;
    /** 注册快报类型（如「快讯快报」）。def 经 normalizeBriefType 消毒；同名后注册覆盖（同 provider 幂等重注册安全）。 */
    registerBriefType(provider: string, def: BriefTypeDef): void;
    /** 注册阅读器视图 tab（iframe 指向 view.url——页由伴随插件自己挂 webServer）。同 provider+id 幂等。 */
    registerView(provider: string, view: ViewDef): void;
    /** 阅读器 tab 数据源（/api/views）。运行时注册——伴随插件卸载即消失，不落库。 */
    listViews(): RegisteredView[];
    /** 注册的快报类型（resolveBriefTypes 与 prefs 类型合并；prefs 同 id 优先） */
    listBriefTypes(): BriefType[];
    /** 主插件注入通知实现（index.ts 在 notifyBrief 定义后回填）。伴随插件不直接摸 desktopNotify。 */
    setNotifier(fn: (title: string, body: string, path?: string) => void): void;
    /**
     * 桌面通知（与时段快报同一通道：prefs.notifyDesktop 门控 + RndNotify/osascript 降级）。
     * path 为阅读器内路径（如 '/dsh-news-kuaixun/'），点击通知时打开对应页面；空则不可点击。
     */
    notify(title: string, body: string, path?: string): void;
}
//# sourceMappingURL=source-hub.d.ts.map