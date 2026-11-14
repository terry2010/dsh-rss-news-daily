/**
 * prefs.json 读写：用户偏好权重（topics/keywords/bannedKeywords/sourceWeight）。
 * M3 提供读写与消毒；M5 的 news_tune/反馈学习在此基础上增改权重。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Prefs } from './scorer.js'
import { EMPTY_PREFS } from './scorer.js'
import type { LogSink } from './types.js'
import { noopLog } from './types.js'

export interface PrefsFile extends Prefs {
  /** 调教历史（M5 写入）：{at, text, actions[]} */
  tuningHistory?: Array<{ at: string; text: string; actions: string[] }>
  /** UI 指定的日报模型覆盖；两个都非空才生效（成对校验同 config） */
  llm?: { provider: string; model: string }
  /** UI 指定的多时间点调度覆盖；digestTimes 空=回 dailyTime */
  schedule?: { digestTimes: string[]; fetchTimes: string[]; intervalMinutes?: number; onStartup?: boolean }
  /** UI 全局代理 URL（fetcher 每次解析：UI 覆盖 > config.fetch.proxyUrl > 环境变量） */
  proxyUrl?: string
  /** 抓取后自动翻译所有外文条目（按条调翻译模型，成本高） */
  autoTranslate?: boolean
  /** 工作区导航显示「新闻」入口（缺省=显示；false=隐藏 guide 条目） */
  showNavEntry?: boolean
  /** 用 dsh-loop-recover 过滤模型输出（缺省=装了自动开） */
  loopGuard?: boolean
  /** 定时备份：周期 + 目录 + 保留份数 */
  backup?: { enabled?: boolean; period?: 'day' | 'week' | 'month'; dir?: string; keep?: number }
  /** 开发日志：完整记录每次模型调用的 prompt/回复、token 用量与生成速度（devlog/ 目录 JSONL） */
  devLog?: boolean
  /** UI 翻译模型覆盖（独立于日报模型 llm） */
  translateLlm?: { provider: string; model: string }
  /** 订阅分类列表（缺省/未设=全部订阅） */
  subscribedTopics?: string[]
  /** 新快报生成时发桌面通知（缺省=关；macOS 点击可打开快报，其余平台仅展示） */
  notifyDesktop?: boolean
  /** UI 日报参数覆盖；单字段未设=跟随 cordis config 默认 */
  digestOpts?: { digestItems?: number; perTopicLimit?: number; minLlmScore?: number; candidateHours?: number; llmScoreCandidates?: number; candidateMax?: number; summaryMaxItems?: number; summaryConcurrency?: number; digestMaxLength?: number; scoreOnFetch?: boolean; rescoreMissing?: boolean; hourlyBrief?: boolean; retentionDays?: number; pruneLowQuality?: boolean; storeMaxItems?: number }
  /** 阅读字号缩放（1=默认）。global=设置页统一值；items/digest/hourly/topics=各页 A−A＋ 分项值；分项优先于 global */
  fontSize?: { global?: number; items?: number; digest?: number; hourly?: number; topics?: number }
  /** 适应宽屏：items=全部新闻页、digest=每日精选页（日报/快报/专题共用）；默认开——显式 false 才回 880px 窄版 */
  wide?: { items?: boolean; digest?: boolean }
  /** 全局 AI 调用并发数（所有模型调用共用一个信号量；1=全串行，本地弱模型建议 1；1-8） */
  llmConcurrency?: number
  /** 无效正文名单：入库新闻正文命中即整条隐藏（归一化等值匹配）；AI 判定无效的短正文自动追加 */
  contentBlocklist?: string[]
  /** 短正文判定阈值（汉字数/英文词数双口径，低于即进名单匹配+AI 判定；缺省 15/10） */
  stubLimits?: { zh?: number; en?: number }
  /** 单价（每百万 tokens，货币自定义）。digest=新闻处理模型，translate=新闻翻译模型；cached 为缓存命中输入价：缺省按入价计，填 0 = 缓存免费 */
  tokenPrice?: { digest?: { in: number; out: number; cached?: number }; translate?: { in: number; out: number; cached?: number } }
  /** 高峰时段暂停：窗口内只抓取不调 AI（start/end 为 'HH:MM' 墙钟，config.timezone 口径；支持跨零点；brief=高峰仍产快报不翻译） */
  peak?: { enabled?: boolean; start?: string; end?: string; brief?: boolean }
}

function numMapOf(v: unknown): Record<string, number> {
  if (typeof v !== 'object' || v === null) return {}
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n
  }
  return out
}

function strListOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
}

/** 把未知输入消毒成 PrefsFile；畸形字段回默认，不抛错。 */
export function normalizePrefs(value: unknown): PrefsFile {
  const r = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const llm = (typeof r.llm === 'object' && r.llm !== null ? r.llm : {}) as Record<string, unknown>
  const sched = (typeof r.schedule === 'object' && r.schedule !== null ? r.schedule : {}) as Record<string, unknown>
  const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/
  const times = (v: unknown) => strListOf(v).filter((t) => TIME_RE.test(t))
  return {
    topics: numMapOf(r.topics),
    keywords: numMapOf(r.keywords),
    bannedKeywords: strListOf(r.bannedKeywords),
    sourceWeight: numMapOf(r.sourceWeight),
    tuningHistory: Array.isArray(r.tuningHistory) ? r.tuningHistory as PrefsFile['tuningHistory'] : [],
    llm: typeof llm.provider === 'string' && typeof llm.model === 'string'
      ? { provider: llm.provider, model: llm.model }
      : undefined,
    schedule: Array.isArray(sched.digestTimes) || Array.isArray(sched.fetchTimes) || typeof sched.intervalMinutes === 'number' || typeof sched.onStartup === 'boolean'
      ? {
          digestTimes: times(sched.digestTimes), fetchTimes: times(sched.fetchTimes),
          ...(typeof sched.intervalMinutes === 'number' && Number.isFinite(sched.intervalMinutes) ? { intervalMinutes: sched.intervalMinutes } : {}),
          ...(typeof sched.onStartup === 'boolean' ? { onStartup: sched.onStartup } : {}),
        }
      : undefined,
    proxyUrl: typeof r.proxyUrl === 'string' && r.proxyUrl ? r.proxyUrl : undefined,
    autoTranslate: r.autoTranslate === true ? true : undefined,
    showNavEntry: r.showNavEntry === false ? false : undefined,
    loopGuard: typeof r.loopGuard === 'boolean' ? (r.loopGuard as boolean) : undefined,
    devLog: r.devLog === true ? true : undefined,
    backup: (() => { const b = (typeof r.backup === 'object' && r.backup !== null ? r.backup : {}) as Record<string, unknown>; const period = b.period === 'week' || b.period === 'month' ? b.period : 'day'; const o = { enabled: b.enabled === true, period: period as 'day' | 'week' | 'month', dir: typeof b.dir === 'string' && b.dir ? b.dir : undefined, keep: typeof b.keep === 'number' && Number.isFinite(b.keep) && b.keep >= 1 ? Math.floor(b.keep) : 7 }; return (o.enabled || o.dir) ? o : undefined })(),
    translateLlm: (() => { const t = (typeof r.translateLlm === 'object' && r.translateLlm !== null ? r.translateLlm : {}) as Record<string, unknown>; return typeof t.provider === 'string' && typeof t.model === 'string' && t.provider && t.model ? { provider: t.provider, model: t.model } : undefined })(),
    subscribedTopics: Array.isArray(r.subscribedTopics) ? (r.subscribedTopics as unknown[]).filter((t): t is string => typeof t === 'string' && !!t) : undefined,
    notifyDesktop: r.notifyDesktop === true ? true : undefined,
    digestOpts: (() => { const d = (typeof r.digestOpts === 'object' && r.digestOpts !== null ? r.digestOpts : {}) as Record<string, unknown>; const b = (k: string) => typeof d[k] === 'boolean' ? (d[k] as boolean) : undefined; const num = (k: string) => typeof d[k] === 'number' && Number.isFinite(d[k]) ? (d[k] as number) : undefined; const o = { digestItems: num('digestItems'), perTopicLimit: num('perTopicLimit'), minLlmScore: num('minLlmScore'), candidateHours: num('candidateHours'), llmScoreCandidates: num('llmScoreCandidates'), candidateMax: num('candidateMax'), summaryMaxItems: num('summaryMaxItems'), summaryConcurrency: num('summaryConcurrency'), digestMaxLength: num('digestMaxLength'), scoreOnFetch: b('scoreOnFetch'), rescoreMissing: b('rescoreMissing'), hourlyBrief: b('hourlyBrief'), retentionDays: num('retentionDays'), pruneLowQuality: b('pruneLowQuality'), storeMaxItems: num('storeMaxItems') }; return Object.values(o).some((v) => v !== undefined) ? o : undefined })(),
    fontSize: (() => { const f = (typeof r.fontSize === 'object' && r.fontSize !== null ? r.fontSize : {}) as Record<string, unknown>; const num = (k: string) => typeof f[k] === 'number' && Number.isFinite(f[k]) ? Math.min(2, Math.max(0.5, Math.round((f[k] as number) * 100) / 100)) : undefined; const o = { global: num('global'), items: num('items'), digest: num('digest'), hourly: num('hourly'), topics: num('topics') }; return Object.values(o).some((v) => v !== undefined) ? o : undefined })(),
    wide: (() => { const w = (typeof r.wide === 'object' && r.wide !== null ? r.wide : {}) as Record<string, unknown>; const b = (k: string) => typeof w[k] === 'boolean' ? (w[k] as boolean) : undefined; const o = { items: b('items'), digest: b('digest') }; return Object.values(o).some((v) => v !== undefined) ? o : undefined })(),
    llmConcurrency: typeof r.llmConcurrency === 'number' && Number.isFinite(r.llmConcurrency) ? Math.min(8, Math.max(1, Math.floor(r.llmConcurrency))) : undefined,
    contentBlocklist: (() => { const seen = new Set<string>(); const out: string[] = []; for (const s of strListOf(r.contentBlocklist)) { const t = s.trim().slice(0, 300); if (t && !seen.has(t)) { seen.add(t); out.push(t) } } return out.length ? out.slice(0, 2000) : undefined })(),
    stubLimits: (() => { const s = (typeof r.stubLimits === 'object' && r.stubLimits !== null ? r.stubLimits : {}) as Record<string, unknown>; const num = (k: string) => typeof s[k] === 'number' && Number.isFinite(s[k]) ? Math.min(500, Math.max(1, Math.floor(s[k]))) : undefined; const o = { zh: num('zh'), en: num('en') }; return Object.values(o).some((v) => v !== undefined) ? o : undefined })(),
    tokenPrice: (() => {
      const t = (typeof r.tokenPrice === 'object' && r.tokenPrice !== null ? r.tokenPrice : {}) as Record<string, unknown>
      const pair = (v: unknown) => { const p = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>; const n = (k: string) => typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0 ? p[k] as number : undefined; const i = n('in'), o = n('out'), c = n('cached'); return i !== undefined || o !== undefined || c !== undefined ? { in: i ?? 0, out: o ?? 0, ...(c !== undefined ? { cached: c } : {}) } : undefined }
      const d = pair(t.digest), tr = pair(t.translate)
      return d || tr ? { ...(d ? { digest: d } : {}), ...(tr ? { translate: tr } : {}) } : undefined
    })(),
    peak: (() => {
      const p = (typeof r.peak === 'object' && r.peak !== null ? r.peak : {}) as Record<string, unknown>
      const t = (v: unknown) => typeof v === 'string' && TIME_RE.test(v.trim()) ? v.trim() : undefined
      const start = t(p.start), end = t(p.end)
      const o = { enabled: p.enabled === true, ...(start ? { start } : {}), ...(end ? { end } : {}), brief: p.brief === true }
      return o.enabled || start || end || o.brief ? o : undefined
    })(),
  }
}

/** prefs.json 的内存门面：load 一次，get() 取当前值，set/save 持久化。 */
export class PrefsStore {
  readonly path: string
  private prefs: PrefsFile
  private readonly log: LogSink

  constructor(path: string, log: LogSink = noopLog) {
    this.path = path
    this.log = log
    this.prefs = { ...EMPTY_PREFS, tuningHistory: [] }
  }

  load(): void {
    if (!existsSync(this.path)) return
    try {
      this.prefs = normalizePrefs(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch (e) {
      this.log.warn(`prefs at ${this.path} unreadable; using defaults (${String(e)})`)
    }
  }

  get(): PrefsFile {
    return this.prefs
  }

  /** 覆盖写（原子 tmp+rename）。 */
  save(next?: Partial<PrefsFile>): void {
    if (next) this.prefs = normalizePrefs({ ...this.prefs, ...next })
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.prefs, null, 2), 'utf8')
    renameSync(tmp, this.path)
  }

  /** 追加一条调教历史并立即生效一组权重改动（M5 用）。 */
  applyTune(text: string, actions: string[], patch: Partial<Prefs>): void {
    this.prefs = normalizePrefs({
      ...this.prefs,
      ...patch,
      tuningHistory: [...(this.prefs.tuningHistory ?? []), { at: new Date().toISOString(), text, actions }],
    })
    this.save()
  }
}
