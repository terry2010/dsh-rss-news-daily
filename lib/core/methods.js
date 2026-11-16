/**
 * 非标抓取方法注册表：伴随插件经 rndSources.registerMethod 注入自定义源适配器。
 * FeedSource.method 原是预留字段——这里启用它：method !== 'direct' 时
 * fetchOne 查本表分发，handler 返回 RawItem[] 后与 RSS 路径汇合
 * （toItem/去重/入库/健康度全部由 fetchOne 统一处理，adapter 只管拿数+映射）。
 *
 * 公开面：MethodHandler / RawItem / MethodCtx / SourceDef 经 index.ts re-export
 * 给伴随插件（devDependencies: file: 引用拿类型），进公开 API semver。
 */
export const registry = new Map();
export const registerMethod = (name, h) => { registry.set(name, h); };
export const methodHandler = (name) => registry.get(name);
/** adapter 游标 kv：写进 store.meta.methodState[srcId]，持久化随后续 store.save() 落盘 */
export function methodKv(store, srcId) {
    const bucket = () => (store.meta.methodState ??= {});
    return {
        get: (k) => bucket()[srcId]?.[k],
        set: (k, v) => { (bucket()[srcId] ??= {})[k] = v; },
    };
}
//# sourceMappingURL=methods.js.map