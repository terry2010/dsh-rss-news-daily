/**
 * 快报类型（brief types）：可增删改的"今日快报列表"生产者。
 *
 * 纯模块：类型定义/prefs 消毒/内置默认解析/槽位调度数学/文件路径/合并视图组装。
 * 被 index.ts（调度+生成）、api.ts（CRUD+读取）、prefs.ts（normalize）共用。
 *
 * 存储布局：
 *  - 内置类型 id='hourly'（builtin）→ `{day}-hourly.md`（历史路径与节格式不变，`## HH:mm 时段快报`）
 *  - 自定义类型 → `digests/briefs/{day}-{id}.md`，节 `## HH:mm {name}`
 * 节名自带类型名 → 「全部」合并视图把各文件切成 ## 节按时倒序拼接即可，无需隐藏标记。
 *
 * 槽位语义（schedule）：
 *  - minutes：距上次运行 ≥ everyMinutes 即到期；从未跑过立即到期
 *  - hourly：每个整点槽 :MM——lastRun < 本槽起点即到期（错过的槽不补，只跑当前槽）
 *  - daily：今日 HH:mm 槽——同理只跑今日槽（当日错过→首次到达即补，跨日不补历史槽）
 */

import { join } from 'node:path'
import { zonedDayKey, zonedDayOccurrence } from './core/time.js'

export type BriefSchedule =
  | { kind: 'minutes'; everyMinutes: number }   // 每 xx 分钟
  | { kind: 'hourly'; minute: number }          // 每小时第 minute 分
  | { kind: 'daily'; time: string }             // 每天 HH:mm

export interface BriefType {
  id: string
  name: string
  /** false=停用（保留配置不出快报） */
  enabled: boolean
  /** 内置默认类型（时段快报）：id='hourly'，写历史文件路径 */
  builtin?: boolean
  schedule: BriefSchedule
  /** 使用新闻源 id 集；空=全部启用源 */
  sourceIds: string[]
  /** 筛选关键字（标题/摘要任一命中 OR）；空=不筛 */
  keywords: string[]
  /** 入选最低评分（llmScore ?? 启发式兜底键） */
  minScore: number
  /** 入文条数上限；0=不限 */
  maxItems: number
  /** 快报重点：注入概括 prompt 的侧重说明；空=通用概括 */
  focus: string
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/

function numOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const strList = (v: unknown, max = 200): string[] => {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) { const s = typeof x === 'string' ? x.trim() : ''; if (s && !out.includes(s)) out.push(s.slice(0, 80)); if (out.length >= max) break }
  return out
}

function normalizeSchedule(v: unknown): BriefSchedule {
  const s = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  if (s.kind === 'minutes') return { kind: 'minutes', everyMinutes: clamp(Math.floor(numOf(s.everyMinutes) ?? 60), 5, 24 * 60) }
  if (s.kind === 'hourly') return { kind: 'hourly', minute: clamp(Math.floor(numOf(s.minute) ?? 0), 0, 59) }
  if (s.kind === 'daily') {
    const t = typeof s.time === 'string' && TIME_RE.test(s.time.trim()) ? s.time.trim() : ''
    if (!t) return { kind: 'minutes', everyMinutes: 60 } // 时间非法回落每小时
    const [h, m] = t.split(':')
    return { kind: 'daily', time: `${h.padStart(2, '0')}:${m}` }
  }
  return { kind: 'minutes', everyMinutes: 60 } // 缺省每小时
}

/** 单条消毒：id/schedule 非法整条丢弃，其余字段畸形回默认。 */
export function normalizeBriefType(v: unknown): BriefType | undefined {
  const r = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  const id = typeof r.id === 'string' && ID_RE.test(r.id) ? r.id : ''
  if (!id) return undefined
  return {
    id,
    name: (typeof r.name === 'string' && r.name.trim() ? r.name.trim() : '快报').slice(0, 60),
    enabled: r.enabled !== false,
    ...(r.builtin === true ? { builtin: true } : {}),
    schedule: normalizeSchedule(r.schedule),
    sourceIds: strList(r.sourceIds),
    keywords: strList(r.keywords, 10),
    minScore: clamp(numOf(r.minScore) ?? 6, 0, 10),
    maxItems: clamp(Math.floor(numOf(r.maxItems) ?? 0), 0, 500),
    focus: (typeof r.focus === 'string' ? r.focus : '').trim().slice(0, 300),
  }
}

/** 数组消毒：非法条目剔除；[] 保持 []（用户删光=真的没有类型）。 */
export function normalizeBriefTypes(v: unknown): BriefType[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.map(normalizeBriefType).filter((t): t is BriefType => !!t)
}

export interface BriefDefaults {
  /** 旧 hourlyBrief 开关作种子 */
  enabled: boolean
  /** 旧 hourlyMinScore 作种子 */
  minScore: number
}

/** 内置默认类型：现有「时段快报」语义等价迁移（写 `{day}-hourly.md`）——每个整点槽 :00 */
export function builtinBriefType(def: BriefDefaults): BriefType {
  return {
    id: 'hourly', name: '时段快报', builtin: true,
    enabled: def.enabled,
    schedule: { kind: 'hourly', minute: 0 },
    sourceIds: [], keywords: [], minScore: def.minScore, maxItems: 0, focus: '',
  }
}

/** prefs.briefTypes 未配置时返回内置默认（「现有的时段快报默认填进去」）；配置过即按表返回。 */
export function resolveBriefTypes(prefs: { briefTypes?: unknown }, def: BriefDefaults): BriefType[] {
  if (Array.isArray(prefs.briefTypes)) return normalizeBriefTypes(prefs.briefTypes) ?? []
  return [builtinBriefType(def)]
}

export function newBriefTypeId(): string {
  return `bt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** UI 频率文案 */
export function briefScheduleText(t: BriefType): string {
  const s = t.schedule
  if (s.kind === 'minutes') return `每 ${s.everyMinutes} 分钟`
  if (s.kind === 'hourly') return `每小时第 ${s.minute} 分`
  return `每天 ${s.time}`
}

// ---- 文件路径 ----

export const briefsDirOf = (digestsDir: string) => join(digestsDir, 'briefs')

/** 类型当日的快报文件：内置写历史路径，自定义写 briefs/ 子目录 */
export function briefFileOf(digestsDir: string, type: { id: string; builtin?: boolean }, day: string): string {
  return type.builtin === true || type.id === 'hourly'
    ? join(digestsDir, `${day}-hourly.md`)
    : join(briefsDirOf(digestsDir), `${day}-${type.id}.md`)
}

/** 读取侧按 key 定位（不问 prefs——已删类型的历史文件照样可读） */
export function briefFileFor(digestsDir: string, typeKey: string, day: string): string {
  return typeKey === 'hourly' ? join(digestsDir, `${day}-hourly.md`) : join(briefsDirOf(digestsDir), `${day}-${typeKey}.md`)
}

// ---- 槽位调度 ----

const DAY_MS = 86_400_000

/** zoned minute-of-day（Intl en-GB，hour % 24 防 '24:xx' 怪癖——同 peak.ts 口径） */
function minutesOfDay(now: Date, timezone?: string): number {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    ...(timezone ? { timeZone: timezone } : {}),
  })
  const parts = fmt.formatToParts(now)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return h * 60 + m
}

/** 每小时 :MM 槽：lastOcc=最近已到达的槽起点（对齐分边界），nextOcc=下一个将到达的槽 */
function hourlySlot(minute: number, now: Date, timezone?: string): { lastOcc: Date; nextOcc: Date } {
  const mm = minutesOfDay(now, timezone) % 60
  const subMin = now.getTime() % 60_000 // 对齐槽起点到分边界：lastRun 落在槽内即算覆盖
  const toLast = mm >= minute ? (mm - minute) : (mm + 60 - minute)
  const toNext = 60 - toLast === 0 ? 60 : 60 - toLast
  return {
    lastOcc: new Date(now.getTime() - toLast * 60_000 - subMin),
    nextOcc: new Date(now.getTime() + toNext * 60_000 - subMin),
  }
}

/** 每天 HH:mm 槽：todayOcc 在未来→昨日槽才是 lastOcc */
function dailyLastOccurrence(time: string, now: Date, timezone?: string): Date {
  const today = zonedDayOccurrence(time, timezone, now)
  if (today.getTime() <= now.getTime()) return today
  return zonedDayOccurrence(time, timezone, new Date(now.getTime() - DAY_MS))
}

/** 当前槽是否未被 lastRun 覆盖（=该跑）。lastRun 是 ISO 时刻（store.meta.briefRuns[id]）。 */
export function briefDue(t: BriefType, lastRunIso: string | undefined, now: Date, timezone?: string): boolean {
  const last = Date.parse(lastRunIso ?? '')
  const s = t.schedule
  if (s.kind === 'minutes') return !Number.isFinite(last) || now.getTime() - last >= s.everyMinutes * 60_000
  const lastOcc = s.kind === 'hourly' ? hourlySlot(s.minute, now, timezone).lastOcc : dailyLastOccurrence(s.time, now, timezone)
  return !Number.isFinite(last) || last < lastOcc.getTime()
}

/** 距下次该跑的毫秒数（到期=0）。调度器取全部启用类型的最小值挂钟。 */
export function nextBriefMs(t: BriefType, lastRunIso: string | undefined, now: Date, timezone?: string): number {
  const last = Date.parse(lastRunIso ?? '')
  const s = t.schedule
  if (s.kind === 'minutes') {
    if (!Number.isFinite(last)) return 0
    return Math.max(0, last + s.everyMinutes * 60_000 - now.getTime())
  }
  if (s.kind === 'hourly') {
    const { lastOcc, nextOcc } = hourlySlot(s.minute, now, timezone)
    if (!Number.isFinite(last) || last < lastOcc.getTime()) return 0
    let n = nextOcc.getTime()
    while (n <= last) n += 3_600_000 // 时钟回拨防御：推进到严格晚于 lastRun 的槽
    return Math.max(0, n - now.getTime())
  }
  const lastOcc = dailyLastOccurrence(s.time, now, timezone)
  if (!Number.isFinite(last) || last < lastOcc.getTime()) return 0
  const todayOcc = zonedDayOccurrence(s.time, timezone, now)
  const next = todayOcc.getTime() > now.getTime() ? todayOcc : zonedDayOccurrence(s.time, timezone, new Date(now.getTime() + DAY_MS))
  return Math.max(0, next.getTime() - now.getTime())
}

/** 类型本次运行的候选窗口起点（ISO）：有 lastRun 取 max(lastRun, 今日0点)，从未跑过取今日0点（首跑覆盖全天）。 */
export function briefWindowStart(lastRunIso: string | undefined, dayStartIso: string): string {
  const last = Date.parse(lastRunIso ?? '')
  if (!Number.isFinite(last) || lastRunIso! < dayStartIso) return dayStartIso
  return lastRunIso!
}

// ---- 合并视图 ----

/** 「今日快报列表-全部」：各类型文件体切成 `## HH:mm <名>` 节，按时刻倒序拼成一篇。无节返回 undefined。 */
export function mergeBriefMarkdown(day: string, bodies: string[]): string | undefined {
  const secs: Array<{ hm: string; text: string }> = []
  for (const body of bodies) {
    for (const c of body.split(/(?=^## )/m)) {
      const m = c.match(/^## (\d{2}:\d{2})\s/)
      if (!m) continue // 文件头/非时段节不并入
      secs.push({ hm: m[1], text: c.replace(/\n{3,}/g, '\n\n').trimEnd() })
    }
  }
  if (!secs.length) return undefined
  secs.sort((a, b) => b.hm.localeCompare(a.hm))
  return `# 今日快报 · ${day}\n\n${secs.map((s) => s.text).join('\n\n')}\n`
}

/** 前端列表行辅助（API 不直接用） */
export function briefDayOf(now: Date, timezone?: string): string {
  return zonedDayKey(now, timezone)
}
