/**
 * 高峰时段判定：每日 [start, end) 窗口（config.timezone 口径，与调度表同时区）。
 * 支持跨零点窗口（如 22:00–06:00）；start==end 视为未配置。
 * 纯模块：所有判定给定 now 即确定，可直接单测。
 */

import { nextZonedOccurrence, parseClockTime } from './time.js'

export interface PeakRange {
  /** 'HH:MM' */
  start: string
  /** 'HH:MM' */
  end: string
}

/** start/end 都合法且不相等才算有效窗口（相等按未配置处理，防误填 00:00–00:00 封死全天） */
export function peakRangeValid(range: PeakRange | undefined): boolean {
  if (!range || typeof range.start !== 'string' || typeof range.end !== 'string') return false
  const s = parseClockTime(range.start)
  const e = parseClockTime(range.end)
  if (!s || !e) return false
  return s.hour * 60 + s.minute !== e.hour * 60 + e.minute
}

/** now 在 timezone 下的当日分钟数（Intl 部件提取，同 time.ts 口径） */
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

/** 当前是否处于高峰窗口内 */
export function isPeak(now: Date, range: PeakRange | undefined, timezone?: string): boolean {
  if (!range || !peakRangeValid(range)) return false
  const s = parseClockTime(range.start)!, e = parseClockTime(range.end)! // valid 已担保
  const sm = s.hour * 60 + s.minute, em = e.hour * 60 + e.minute
  const cur = minutesOfDay(now, timezone)
  return sm < em ? (cur >= sm && cur < em) : (cur >= sm || cur < em)
}

/** 下一次窗口边界（进峰或出峰）的 UTC 时刻；无效窗口返回 undefined。
 *  进峰/出峰两类边界合并取近者：start 与 end 各自的下一次出现时刻取 min。 */
export function nextPeakTransition(now: Date, range: PeakRange | undefined, timezone?: string): Date | undefined {
  if (!range || !peakRangeValid(range)) return undefined
  try {
    const a = nextZonedOccurrence(range.start, timezone, now)
    const b = nextZonedOccurrence(range.end, timezone, now)
    return a.secondsUntil <= b.secondsUntil ? a.next : b.next
  } catch { return undefined }
}

/** 「排低峰队列」快报的槽位窗口：start=入队时最近一轮抓取起点（槽内容=那批条目）；
 *  超 staleMs 无抓取说明没有"当前这批"——槽=此刻（快报自然为空时段）。end=入队时刻：
 *  之后峰内抓的批次归各自的槽，不进本节。 */
export function slotBriefWindow(lastFetchIso: string | undefined, nowIso: string, staleMs = 90 * 60 * 1000): { start: string; end: string } {
  const t = Date.parse(lastFetchIso ?? '')
  const fresh = Number.isFinite(t) && Date.parse(nowIso) - t >= 0 && Date.parse(nowIso) - t <= staleMs
  return { start: fresh ? lastFetchIso! : nowIso, end: nowIso }
}
