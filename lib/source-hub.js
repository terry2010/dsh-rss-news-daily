/**
 * rndSources 服务：伴随插件的公开注册面。
 *
 * 伴随插件 `export const inject = ['rndSources']` 后在本服务上只做两件事：
 *   - registerMethod('<包名>:<方法>', handler)  注册非标抓取 handler
 *   - addSources('<包名>', defs)                注入源定义（provider 落源上，卸载可识别）
 *
 * 调度/解析/去重/健康度/存储/日报管线全部归主插件——伴随插件只「给数据」。
 * 公开 API 面，签名进 semver；apiVersion 供伴随插件首行检查。
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { registry, registerMethod } from './core/methods.js';
/** 对外注册面：伴随插件只摸这几个方法。公开 API，进 semver。 */
export class RndSourceHub extends Service {
    addSourcesImpl;
    /** 伴随插件首行检查：`if (ctx.rndSources.apiVersion < 1) return` */
    apiVersion = 1;
    constructor(ctx, addSourcesImpl) {
        super(ctx, 'rndSources');
        this.addSourcesImpl = addSourcesImpl;
    }
    /** 注册非标抓取 handler。命名约定 '<包名>:<方法>'；重名拒绝（防两个伴随插件互相覆盖）。 */
    registerMethod(name, handler) {
        if (!name.includes(':')) {
            this.ctx.logger('rndSources').warn(`method "${name}" lacks a '<package>:' namespace prefix`);
        }
        if (registry.has(name))
            throw new Error(`rndSources: duplicate method "${name}"`);
        registerMethod(name, handler);
    }
    /** provider = 调用方插件 id（传自己的 export const name）——卸载后遗留源可识别/禁用/清理 */
    addSources(provider, defs) {
        this.addSourcesImpl(provider, defs);
    }
}
//# sourceMappingURL=source-hub.js.map