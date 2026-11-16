/**
 * rndSources 服务：伴随插件的公开注册面。
 *
 * 伴随插件 `export const inject = ['rndSources']` 后在本服务上可做五件事：
 *   - registerMethod('<包名>:<方法>', handler)  注册非标抓取 handler
 *   - addSources('<包名>', defs)                注入源定义（provider 落源上，卸载可识别）
 *   - registerBriefType('<包名>', def)          注册快报类型（id 冲突时用户已存配置优先）
 *   - registerView('<包名>', view)              给阅读器顶部贡献 iframe tab（页挂自己 webServer 路由）
 *   - notify(title, body, path)                 请求桌面通知（与快报同一通道；path=点击打开的阅读器路径）
 *
 * 调度/解析/去重/健康度/存储/日报管线全部归主插件——伴随插件只「给数据」。
 * 公开 API 面，签名进 semver；apiVersion 供伴随插件首行检查。
 */

import { Context, Service } from '@deepseek-ai/cordis'

import { registry, registerMethod } from './core/methods.js'
import type { MethodHandler, SourceDef, ViewDef, BriefTypeDef } from './core/methods.js'
import { normalizeBriefType, type BriefType } from './brief-types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    rndSources: RndSourceHub
  }
}

export interface RegisteredView extends ViewDef {
  provider: string
}

/** 对外注册面：伴随插件只摸这几个方法。公开 API，进 semver。 */
export class RndSourceHub extends Service {
  /** 伴随插件首行检查：`if (ctx.rndSources.apiVersion < 1) return` */
  readonly apiVersion = 1

  private readonly views = new Map<string, RegisteredView>()   // `${provider}:${id}` → view
  private readonly briefTypes = new Map<string, BriefType>()   // id → type（注册表为准，prefs 同 id 覆盖）
  private notifier?: (title: string, body: string, path?: string) => void

  constructor(
    ctx: Context,
    private readonly addSourcesImpl: (provider: string, defs: SourceDef[]) => void,
  ) {
    super(ctx, 'rndSources')
  }

  /** 注册非标抓取 handler。命名约定 '<包名>:<方法>'；重名拒绝（防两个伴随插件互相覆盖）。 */
  registerMethod(name: string, handler: MethodHandler): void {
    if (!name.includes(':')) {
      this.ctx.logger('rndSources').warn(`method "${name}" lacks a '<package>:' namespace prefix`)
    }
    if (registry.has(name)) throw new Error(`rndSources: duplicate method "${name}"`)
    registerMethod(name, handler)
  }

  /** provider = 调用方插件 id（传自己的 export const name）——卸载后遗留源可识别/禁用/清理 */
  addSources(provider: string, defs: SourceDef[]): void {
    this.addSourcesImpl(provider, defs)
  }

  /** 注册快报类型（如「快讯快报」）。def 经 normalizeBriefType 消毒；同名后注册覆盖（同 provider 幂等重注册安全）。 */
  registerBriefType(provider: string, def: BriefTypeDef): void {
    const t = normalizeBriefType({ enabled: true, sourceIds: [], keywords: [], minScore: 6, maxItems: 0, focus: '', ...def })
    if (!t) { this.ctx.logger('rndSources').warn(`briefType "${def?.id}" rejected (bad id)`); return }
    this.briefTypes.set(t.id, t)
    this.ctx.logger('rndSources').info(`briefType "${t.id}" registered by ${provider}`)
  }

  /** 注册阅读器视图 tab（iframe 指向 view.url——页由伴随插件自己挂 webServer）。同 provider+id 幂等。 */
  registerView(provider: string, view: ViewDef): void {
    if (!view?.id || !view.title || !view.url) { this.ctx.logger('rndSources').warn('registerView: id/title/url required'); return }
    this.views.set(`${provider}:${view.id}`, { ...view, provider })
    this.ctx.logger('rndSources').info(`view "${view.id}" registered by ${provider}`)
  }

  /** 阅读器 tab 数据源（/api/views）。运行时注册——伴随插件卸载即消失，不落库。 */
  listViews(): RegisteredView[] {
    return [...this.views.values()]
  }

  /** 注册的快报类型（resolveBriefTypes 与 prefs 类型合并；prefs 同 id 优先） */
  listBriefTypes(): BriefType[] {
    return [...this.briefTypes.values()]
  }

  /** 主插件注入通知实现（index.ts 在 notifyBrief 定义后回填）。伴随插件不直接摸 desktopNotify。 */
  setNotifier(fn: (title: string, body: string, path?: string) => void): void {
    this.notifier = fn
  }

  /**
   * 桌面通知（与时段快报同一通道：prefs.notifyDesktop 门控 + RndNotify/osascript 降级）。
   * path 为阅读器内路径（如 '/dsh-news-kuaixun/'），点击通知时打开对应页面；空则不可点击。
   */
  notify(title: string, body: string, path?: string): void {
    try { this.notifier?.(title, body, path) } catch { /* 通知失败不影响抓取 */ }
  }
}
