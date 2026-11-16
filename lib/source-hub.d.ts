/**
 * rndSources 服务：伴随插件的公开注册面。
 *
 * 伴随插件 `export const inject = ['rndSources']` 后在本服务上可做四件事：
 *   - registerMethod('<包名>:<方法>', handler)  注册非标抓取 handler
 *   - addSources('<包名>', defs)                注入源定义（provider 落源上，卸载可识别）
 *   - registerBriefType('<包名>', def)          注册快报类型（id 冲突时用户已存配置优先）
 *   - registerView('<包名>', view)              给阅读器顶部贡献 iframe tab（页挂自己 webServer 路由）
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
    /** 伴随插件首行检查：`if (ctx.rndSources.apiVersion < 1) return` */
    readonly apiVersion = 1;
    private readonly views;
    private readonly briefTypes;
    constructor(ctx: Context, addSourcesImpl: (provider: string, defs: SourceDef[]) => void);
    /** 注册非标抓取 handler。命名约定 '<包名>:<方法>'；重名拒绝（防两个伴随插件互相覆盖）。 */
    registerMethod(name: string, handler: MethodHandler): void;
    /** provider = 调用方插件 id（传自己的 export const name）——卸载后遗留源可识别/禁用/清理 */
    addSources(provider: string, defs: SourceDef[]): void;
    /** 注册快报类型（如「快讯快报」）。def 经 normalizeBriefType 消毒；同名后注册覆盖（同 provider 幂等重注册安全）。 */
    registerBriefType(provider: string, def: BriefTypeDef): void;
    /** 注册阅读器视图 tab（iframe 指向 view.url——页由伴随插件自己挂 webServer）。同 provider+id 幂等。 */
    registerView(provider: string, view: ViewDef): void;
    /** 阅读器 tab 数据源（/api/views）。运行时注册——伴随插件卸载即消失，不落库。 */
    listViews(): RegisteredView[];
    /** 注册的快报类型（resolveBriefTypes 与 prefs 类型合并；prefs 同 id 优先） */
    listBriefTypes(): BriefType[];
}
//# sourceMappingURL=source-hub.d.ts.map