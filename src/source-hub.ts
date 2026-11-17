/**
 * rndSources 服务：伴随插件的公开注册面。
 *
 * 伴随插件 `export const inject = ['rndSources']` 后在本服务上可做五件事：
 *   - registerMethod('<包名>:<方法>', handler)  注册非标抓取 handler
 *   - addSources('<包名>', defs)                注入源定义（provider 落源上，卸载可识别）
 *   - registerBriefType('<包名>', def, opts?)   注册快报类型（id 冲突时用户已存配置优先）；
 *                                             opts.items=条目供给器——自管库伴随插件的条目不进主库，
 *                                             快报到期时由主插件回调取数（since=本类型候选窗口起点 ISO）；
 *                                             糖：以 def.id/name/sourceNames 自动建同名条目池
 *   - registerBriefPool('<包名>', pool, supplier) 注册快报条目池（供给器+sourceNames）；
 *                                             任意 BriefType.poolId 可挂接，用户 UI 新增快报也能选
 *   - registerView('<包名>', view)              给阅读器顶部贡献 iframe tab（页挂自己 webServer 路由）
 *   - notify(title, body, path)                 请求桌面通知（与快报同一通道；path=点击打开的阅读器路径）
 *   - removeSources(provider)                   清掉自己注入过的源及其条目（伴随插件转向独立存储时的卸载通道）
 *
 * 调度/解析/去重/健康度/存储/日报管线全部归主插件——伴随插件只「给数据」。
 * 公开 API 面，签名进 semver；apiVersion 供伴随插件首行检查。
 */

import { Context, Service } from '@deepseek-ai/cordis'

import { registry, registerMethod } from './core/methods.js'
import type { MethodHandler, SourceDef, ViewDef, BriefTypeDef } from './core/methods.js'
import { normalizeBriefType, ID_RE, type BriefType } from './brief-types.js'
import type { FeedItem } from './core/types.js'

/** 快报条目供给器：主插件在本类型槽位到期时回调，since=候选窗口起点 ISO；返回本窗口应参评的条目 */
export type BriefItemSupplier = (since: string) => FeedItem[] | Promise<FeedItem[]>

/** 快报条目池：供给器+来源显示名，多个快报类型可经 poolId 共享；运行时注册，随伴随插件卸载消失 */
export interface BriefPool {
  id: string
  name: string
  /** 池内条目的来源显示名（sourceId→名）——任何挂该池的类型节内标注共用 */
  sourceNames: Record<string, string>
  supplier: BriefItemSupplier
}

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
  /** 伴随插件首行检查：`if (ctx.rndSources.apiVersion < 1) return`；v2 起 registerBriefType opts.items；v3 起 registerBriefPool/BriefType.poolId */
  readonly apiVersion = 3

  private readonly views = new Map<string, RegisteredView>()   // `${provider}:${id}` → view
  private readonly briefTypes = new Map<string, BriefType>()   // id → type（注册表为准，prefs 同 id 覆盖）
  /** poolId → 池定义：条目供给器+来源显示名；卸载伴随插件随注册表一起消失 */
  private readonly briefPools = new Map<string, BriefPool>()
  private notifier?: (title: string, body: string, path?: string) => void

  constructor(
    ctx: Context,
    private readonly addSourcesImpl: (provider: string, defs: SourceDef[]) => void,
    private readonly removeSourcesImpl?: (provider: string) => Promise<number>,
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

  /**
   * 删除 provider 名下的全部源及其条目（幂等）。
   * 伴随插件从「注入主库」转向「独立存储」时调用，把历史数据从主库清干净。
   * 返回删除的源数；主插件未注入实现时返回 0。
   */
  async removeSources(provider: string): Promise<number> {
    if (!this.removeSourcesImpl) return 0
    try { return await this.removeSourcesImpl(provider) }
    catch (e) { this.ctx.logger('rndSources').warn(`removeSources(${provider}) failed: ${(e as Error).message}`); return 0 }
  }

  /**
   * 注册快报类型（如「快讯快报」）。def 经 normalizeBriefType 消毒；同名后注册覆盖（同 provider 幂等重注册安全）。
   * opts.items：自管库伴随插件的条目供给器——其条目不进主库 store，槽位到期时主插件调 since→items 取数；
   * 不传则候选池照旧扫主库（addSources 注入路径）。
   */
  registerBriefType(provider: string, def: BriefTypeDef, opts?: { items?: BriefItemSupplier }): void {
    const t = normalizeBriefType({ enabled: true, sourceIds: [], keywords: [], minScore: 6, maxItems: 0, focus: '', ...def })
    if (!t) { this.ctx.logger('rndSources').warn(`briefType "${def?.id}" rejected (bad id)`); return }
    if (opts?.items) t.poolId = t.id // items 糖：同名建池并挂接（v2 调用形状不变）
    this.briefTypes.set(t.id, t)
    if (opts?.items) this.registerBriefPool(provider, { id: t.id, name: t.name, sourceNames: t.sourceNames }, opts.items)
    this.ctx.logger('rndSources').info(`briefType "${t.id}" registered by ${provider}${opts?.items ? ' (items supplier)' : ''}`)
  }

  /**
   * 注册快报条目池（apiVersion≥3）：池=条目供给器+来源显示名，可被任意多个快报类型经
   * BriefType.poolId 挂接——用户在 UI 新增快报时也能选到本池（装了插件才有，卸载即消失）。
   */
  registerBriefPool(provider: string, pool: { id: string; name: string; sourceNames?: Record<string, string> }, supplier: BriefItemSupplier): void {
    if (!ID_RE.test(String(pool?.id ?? '')) || !String(pool?.name ?? '').trim()) {
      this.ctx.logger('rndSources').warn(`briefPool "${pool?.id}" rejected (bad id/name)`); return
    }
    this.briefPools.set(pool.id, { id: pool.id, name: String(pool.name).trim().slice(0, 40), sourceNames: pool.sourceNames ?? {}, supplier })
    this.ctx.logger('rndSources').info(`briefPool "${pool.id}" registered by ${provider}`)
  }

  /** 池查询：briefRunWork 按 BriefType.poolId 路由取数；UI 列可选池 */
  briefPoolOf(poolId: string): BriefPool | undefined {
    return this.briefPools.get(poolId)
  }

  listBriefPools(): Array<{ id: string; name: string; sourceNames: Record<string, string> }> {
    return [...this.briefPools.values()].map(({ supplier: _, ...p }) => p)
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
