/**
 * 每日更新检查：启动 delayMinutes 后向 update 端点上报一次自身版本 +
 * 已安装伴随插件版本，拉回最新升级信息；每个自然日最多一次（成败都计）。
 *
 * 隐私口径（docs 详设 §2.4）：上行仅 {pkg, version, companions} 三字段，
 * 无 install ID/OS/UA 指纹；端点非 https 直接拒跑（防降级伪造更新信息）。
 *
 * 伴随插件版本来源：profile 清单 package.json 的 dependencies（cordis
 * registry 只有插件名没有版本）。manifest 定位 = 从自身模块路径向上找第一
 * 个含 dsh.profile.bundles 的 package.json；找不到回退扫 DSH_HOME/profiles。
 * file: spec（dev 安装）跟随读真实版本。
 *
 * fetch/fs/clock 全注入，纯逻辑可测。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TimerSeam } from './scheduler.js'
import { zonedDayKey } from './core/time.js'
import type { LogSink } from './core/types.js'
import { noopLog } from './core/types.js'

/** 上行 payload —— 用户定稿的最小集，勿加字段（隐私口径）。 */
export interface UpdateReport {
  pkg: string
  version: string
  companions: Record<string, string>
}

/** 下行响应（服务端 latest.json 消毒后形状）。 */
export interface UpdateInfo {
  latest: string
  url?: string
  notes?: string
  minSupported?: string
  companions?: Record<string, { latest: string; url?: string }>
}

/** store.meta.updateCheck 台账形状（StoreMeta 同步定义于 core/store.ts）。 */
export interface UpdateCheckState {
  /** 当天已尝试过的判据——成败都记，"每天只检查一次"优先于"不漏检查" */
  lastAttemptDay: string
  lastCheckedAt?: string
  latest?: string
  hasUpdate?: boolean
  url?: string
  notes?: string
}

const RESPONSE_CAP = 16 * 1024
const COMPANION_PREFIX = 'dsh-rss-news-'

/** 宽松 semver 比较：x[.y[.z]][-prerelease]。返回 -1|0|1。预发版 < 同号正式版。 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-.]([0-9a-zA-Z.]+))?$/.exec(v.trim())
    if (!m) return null
    return { num: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? '' }
  }
  const pa = parse(a), pb = parse(b)
  if (!pa || !pb) return 0 // 解析不出不比——宁可漏报不误报
  for (let i = 0; i < 3; i++) if (pa.num[i] !== pb.num[i]) return pa.num[i]! < pb.num[i]! ? -1 : 1
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  return pa.pre < pb.pre ? -1 : 1
}

/** 从 manifest dependencies 筛伴随插件：dsh-rss-news-* 前缀且 ≠ 自身。
 *  file: spec 交给 resolver 还原真实版本；还原不了就报 spec 字面量（如实上报）。 */
export function companionVersions(
  deps: Record<string, string>,
  selfPkg: string,
  resolveFileVer?: (spec: string) => string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, spec] of Object.entries(deps)) {
    if (!name.startsWith(COMPANION_PREFIX) || name === selfPkg) continue
    out[name] = spec.startsWith('file:') ? (resolveFileVer?.(spec) ?? spec) : spec.replace(/^[\^~]/, '')
  }
  return out
}

interface ProfileManifest { deps: Record<string, string>; dir: string }

function readManifest(pkgPath: string, selfPkg: string): ProfileManifest | undefined {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = pkg.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || !bundles.includes(selfPkg)) return undefined
    return { deps: pkg.dependencies ?? {}, dir: dirname(pkgPath) }
  } catch { return undefined }
}

/** manifest 定位主路径：从插件自身安装位置逐级向上，找含 dsh.profile.bundles
 *  （且 bundles 含本包）的 package.json——即当前运行 profile 的根。 */
export function findProfileDeps(fromDir: string, selfPkg: string): ProfileManifest | undefined {
  let dir = resolve(fromDir)
  for (let i = 0; i < 12; i++) {
    const hit = readManifest(join(dir, 'package.json'), selfPkg)
    if (hit) return hit
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** 回退：dev link 等场景向上找不到时，扫 <dshHome>/profiles/*\/package.json，
 *  取第一个 bundles 含本包的 profile（确定性：目录名排序）。 */
export function scanProfileDeps(dshHome: string, selfPkg: string): ProfileManifest | undefined {
  const profiles = join(dshHome, 'profiles')
  if (!existsSync(profiles)) return undefined
  for (const name of readdirSync(profiles).sort()) {
    const hit = readManifest(join(profiles, name, 'package.json'), selfPkg)
    if (hit) return hit
  }
  return undefined
}

/** 汇总：manifest 定位（向上→扫 profiles）→ file: 还原 → 伴随表。 */
export function listCompanions(selfPkg: string, opts: { fromDir?: string; dshHome?: string } = {}): Record<string, string> {
  const manifest = (opts.fromDir ? findProfileDeps(opts.fromDir, selfPkg) : undefined)
    ?? (opts.dshHome ? scanProfileDeps(opts.dshHome, selfPkg) : undefined)
  if (!manifest) return {}
  return companionVersions(manifest.deps, selfPkg, (spec) => {
    const p = spec.slice(5) // 'file:'.length
    const abs = isAbsolute(p) ? p : resolve(manifest.dir, p)
    try {
      const v = (JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8')) as { version?: unknown }).version
      return typeof v === 'string' ? v : undefined
    } catch { return undefined }
  })
}

/** 响应消毒：shape 不对/字段类型不对 → null（服务端被劫持也只能拿到"无更新"）。 */
export function sanitizeUpdateInfo(v: unknown): UpdateInfo | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (typeof o.latest !== 'string' || !/^\d+\.\d+/.test(o.latest)) return null
  const out: UpdateInfo = { latest: o.latest }
  if (typeof o.url === 'string' && /^https?:\/\//.test(o.url)) out.url = o.url
  if (typeof o.notes === 'string') out.notes = o.notes.slice(0, 200)
  if (typeof o.minSupported === 'string') out.minSupported = o.minSupported
  if (typeof o.companions === 'object' && o.companions !== null) {
    const c: Record<string, { latest: string; url?: string }> = {}
    for (const [name, info] of Object.entries(o.companions as Record<string, unknown>)) {
      const i = info as Record<string, unknown>
      if (typeof i?.latest === 'string') {
        c[name] = { latest: i.latest, ...(typeof i.url === 'string' && /^https?:\/\//.test(i.url) ? { url: i.url } : {}) }
      }
    }
    out.companions = c
  }
  return out
}

/** 打一次端点；任何失败/异常 → null（调用方只 log，不阻断主流程）。 */
export async function runUpdateCheck(opts: {
  endpoint: string
  timeoutMs: number
  report: UpdateReport
  fetchImpl?: typeof fetch
  log?: LogSink
}): Promise<UpdateInfo | null> {
  const log = opts.log || noopLog
  if (!opts.endpoint.startsWith('https://')) { log.warn(`update check skipped: non-https endpoint ${opts.endpoint}`); return null }
  try {
    const res = await (opts.fetchImpl ?? fetch)(opts.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `${opts.report.pkg}/${opts.report.version}` },
      body: JSON.stringify(opts.report),
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
    if (!res.ok) { log.warn(`update check: HTTP ${res.status}`); return null }
    const text = await res.text()
    if (text.length > RESPONSE_CAP) { log.warn('update check: response too large'); return null }
    return sanitizeUpdateInfo(JSON.parse(text))
  } catch (e) {
    log.warn(`update check failed: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

export interface StartUpdateCheckOpts {
  enabled: () => boolean
  endpoint: () => string
  delayMs: number
  timeoutMs: number
  timezone?: string
  selfPkg: string
  selfVer: string
  companions: () => Record<string, string>
  /** 可写 meta 对象（两后端 get meta() 都返回引用，直接改 + save 即持久化） */
  meta: () => { updateCheck?: UpdateCheckState }
  save: () => void
  /** 发现新版本时的回调（系统通知等），url 可空 */
  onUpdate?: (info: UpdateInfo) => void
  now?: () => Date
  fetchImpl?: typeof fetch
  log?: LogSink
}

/** 装配启动延迟定时器；返回 disposer（插件重载清钟用）。 */
export function startUpdateCheck(timer: TimerSeam, opts: StartUpdateCheckOpts): () => void {
  const log = opts.log || noopLog
  const fire = async (): Promise<void> => {
    if (!opts.enabled()) return
    const today = zonedDayKey((opts.now ?? (() => new Date()))(), opts.timezone || undefined)
    const meta = opts.meta()
    if (meta.updateCheck?.lastAttemptDay === today) return // 今天已试过（成败都算）
    meta.updateCheck = { ...(meta.updateCheck ?? { lastAttemptDay: '' }), lastAttemptDay: today }
    opts.save()
    const info = await runUpdateCheck({
      endpoint: opts.endpoint(), timeoutMs: opts.timeoutMs,
      report: { pkg: opts.selfPkg, version: opts.selfVer, companions: opts.companions() },
      fetchImpl: opts.fetchImpl, log,
    })
    if (!info) return
    const hasUpdate = compareSemver(info.latest, opts.selfVer) > 0
    meta.updateCheck = { ...meta.updateCheck, lastAttemptDay: today, lastCheckedAt: new Date().toISOString(), latest: info.latest, url: info.url, notes: info.notes, hasUpdate }
    opts.save()
    log.info(hasUpdate ? `update available: ${opts.selfVer} → ${info.latest}` : `update check: ${opts.selfVer} up to date`)
    if (hasUpdate) opts.onUpdate?.(info)
  }
  return timer.timeout(() => { void fire().catch((e) => log.warn(`update check crashed: ${e instanceof Error ? e.message : String(e)}`)) }, opts.delayMs)
}
