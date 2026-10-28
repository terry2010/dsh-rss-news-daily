/**
 * 调度：抓取轮询 + 每日日报锚点 + 启动补跑，基于 timer 服务的 ctx.timeout/interval。
 * 每日定时器每次跑完重新计算下一个墙钟时刻（nextZonedOccurrence），
 * 对重启/漂移/DST 都稳。
 */

import type { FetchSectionConfig } from './config.js'
import { nextZonedOccurrence, zonedDayKey, parseClockTime } from './core/time.js'
import type { FetchCycleResult, LogSink } from './core/types.js'
import { noopLog } from './core/types.js'

export interface SchedulerOptions {
  fetch: FetchSectionConfig
  /** 每日日报配置（digest.enabled 用 llm/summary 不相关，这里只要时间与补跑窗口） */
  dailyTime: string
  timezone: string
  catchUpHours: number
  enabled: boolean
  /** 已生成日报的最近日期（YYYY-MM-DD，来自 store.meta.lastDigestDay） */
  lastDigestDay: () => string
  runFetchCycle: (signal?: AbortSignal) => Promise<FetchCycleResult>
  runDailyDigest: () => Promise<unknown>
  /** 生效时间表：digestTimes 空则回落 [dailyTime]；每次 arm 时重读（UI 改动下一跳生效） */
  getSchedule?: () => { digestTimes: string[]; fetchTimes: string[] }
  log?: LogSink
}

const STARTUP_FETCH_DELAY_MS = 10_000
const CATCHUP_DELAY_MS = 15_000

/** timer 服务挂到 ctx 上的接缝（ctx.timeout/ctx.interval）——类型上 Context 不声明它，用结构类型接。 */
export interface TimerSeam {
  timeout(fn: () => void, ms: number): () => void
  interval(fn: () => void, ms: number): () => void
}

/** 装配全部周期任务；返回 disposer。 */
export function startScheduler(ctx: TimerSeam, options: SchedulerOptions): () => void {
  const log = options.log || noopLog
  const disposers: Array<() => void> = []
  let nextTimer: (() => void) | undefined

  // ---- 抓取轮询 ----
  // 周期块只负责 interval；onStartup 独立挂钟——只勾"启动即抓"不开轮询也要生效
  const mkCycle = () => {
    let running = false
    return (): void => {
      if (running) return // 防重入
      running = true
      void options
        .runFetchCycle()
        .catch((error) => log.error('scheduled fetch cycle failed', error))
        .finally(() => { running = false })
    }
  }
  if (options.fetch.enabled) {
    const cycle = mkCycle()
    if (options.fetch.onStartup) disposers.push(ctx.timeout(cycle, STARTUP_FETCH_DELAY_MS))
    if (options.fetch.intervalMinutes >= 5) disposers.push(ctx.interval(cycle, options.fetch.intervalMinutes * 60_000))
  }

  // ---- 多时间点定时（fetch + digest 统一挂钟；同刻先 fetch 后 digest） ----
  if (options.enabled) {
    let scheduledRunning = false
    const fire = (doFetch: boolean, doDigest: boolean): void => {
      if (scheduledRunning) return
      scheduledRunning = true
      void (async () => {
        if (doFetch) await options.runFetchCycle().catch((e) => log.error('scheduled fetch failed', e))
        if (doDigest) await options.runDailyDigest().catch((e) => log.error('scheduled digest failed', e))
      })().finally(() => {
        scheduledRunning = false
        armNext()
      })
    }

    const armNext = (): void => {
      try {
        nextTimer?.() // 先清旧句柄：catch-up 路径会重复 armNext，防双挂钟
        const sched = options.getSchedule?.() ?? { digestTimes: [options.dailyTime], fetchTimes: [] }
        const digestTimes = sched.digestTimes.length ? sched.digestTimes : [options.dailyTime]
        const fetchTimes = sched.fetchTimes
        // 取两表所有时刻里最近的下一跳；归属按 secondsUntil 相等判定（'8:00'/'08:00' 异形同刻不误判）
        const now = new Date()
        const secsOf = (t: string): number => {
          try { return nextZonedOccurrence(t, options.timezone || undefined, now).secondsUntil }
          catch { log.warn(`invalid schedule time skipped: ${t}`); return Number.POSITIVE_INFINITY }
        }
        let bestSecs = Number.POSITIVE_INFINITY
        for (const t of [...digestTimes, ...fetchTimes]) bestSecs = Math.min(bestSecs, secsOf(t))
        if (bestSecs === Number.POSITIVE_INFINITY) return
        const inTable = (times: string[]) => times.some((t) => secsOf(t) === bestSecs)
        const doDigest = inTable(digestTimes)
        const doFetch = inTable(fetchTimes)
        nextTimer = ctx.timeout(() => fire(doFetch, doDigest), bestSecs * 1000)
      } catch (error) {
        log.error(`digest scheduler not armed (invalid dailyTime/timezone): ${String(error)}`)
      }
    }

    // 启动补跑：今天尚无日报 && 已过 dailyTime && 未超 catchUpHours → 立即补一次。
    // 用 zone 感知的 nextZonedOccurrence 反推"最近一次应跑时刻"（next-24h），时区正确且免手写时钟。
    try {
      const clock = parseClockTime(options.dailyTime)
      if (clock && options.lastDigestDay() !== zonedDayKey(new Date(), options.timezone || undefined)) {
        const now = new Date()
        const { secondsUntil } = nextZonedOccurrence(options.dailyTime, options.timezone || undefined, now)
        // 最近一次应跑时刻距今的秒数 = 86400 - secondsUntil（secondsUntil<86400 即今天已错过）
        const secondsSinceLast = 86400 - secondsUntil
        if (secondsSinceLast > 0 && secondsSinceLast <= options.catchUpHours * 3600) {
          log.info(`catch-up: today's digest missing (${Math.round(secondsSinceLast / 60)}min late), firing in ${CATCHUP_DELAY_MS / 1000}s`)
          disposers.push(ctx.timeout(() => fire(false, true), CATCHUP_DELAY_MS))
        }
      }
    } catch (error) {
      log.warn(`catch-up check skipped: ${String(error)}`)
    }

    armNext()
  }

  return () => {
    for (const dispose of disposers) dispose()
    nextTimer?.()
  }
}
