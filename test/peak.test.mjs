import { test } from 'node:test'
import assert from 'node:assert/strict'

const deferred = () => { let resolve, reject; const p = new Promise((res, rej) => { resolve = res; reject = rej }); return { p, resolve, reject } }
const tick = () => new Promise((r) => setImmediate(r))
const silentLog = { warn() {}, error() {}, info() {} }
// Asia/Shanghai=UTC+8 无 DST——墙钟换算确定，测试不受运行机器时区影响
const TZ = 'Asia/Shanghai'
const utc = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi))

test('isPeak: 同日窗口——内/外/两端边界（start 含,end 排）', async () => {
  const { isPeak } = await import('../lib/core/peak.js')
  const w = { start: '09:00', end: '23:00' }
  assert.equal(isPeak(utc(2026, 1, 15, 4, 0), w, TZ), true)  // 本地 12:00 窗内
  assert.equal(isPeak(utc(2026, 1, 15, 1, 0), w, TZ), true)  // 本地 09:00 起点含
  assert.equal(isPeak(utc(2026, 1, 15, 15, 0), w, TZ), false) // 本地 23:00 终点排
  assert.equal(isPeak(utc(2026, 1, 15, 20, 0), w, TZ), false) // 本地次日 04:00 窗外
})

test('isPeak: 跨零点窗口——深夜/凌晨都算窗内,白天窗外', async () => {
  const { isPeak } = await import('../lib/core/peak.js')
  const w = { start: '22:00', end: '06:00' }
  assert.equal(isPeak(utc(2026, 1, 15, 14, 0), w, TZ), true)  // 本地 22:00 起点含
  assert.equal(isPeak(utc(2026, 1, 15, 20, 0), w, TZ), true)  // 本地次日 04:00 窗内
  assert.equal(isPeak(utc(2026, 1, 15, 22, 0), w, TZ), false) // 本地次日 06:00 终点排
  assert.equal(isPeak(utc(2026, 1, 15, 12, 0), w, TZ), false) // 本地 20:00 窗外
})

test('isPeak/peakRangeValid: start==end 及坏格式按未启用（防 00:00–00:00 封死全天）', async () => {
  const { isPeak, peakRangeValid } = await import('../lib/core/peak.js')
  assert.equal(peakRangeValid({ start: '09:00', end: '23:00' }), true)
  assert.equal(peakRangeValid({ start: '00:00', end: '00:00' }), false)
  assert.equal(peakRangeValid({ start: '9', end: '23:00' }), false)
  assert.equal(peakRangeValid({ start: '09:00' }), false)
  assert.equal(peakRangeValid(undefined), false)
  assert.equal(isPeak(utc(2026, 1, 15, 4, 0), { start: '09:00', end: '09:00' }, TZ), false)
  assert.equal(isPeak(utc(2026, 1, 15, 4, 0), undefined, TZ), false)
})

test('nextPeakTransition: 返回最近的下一次边界（进峰/出峰取近者）', async () => {
  const { nextPeakTransition } = await import('../lib/core/peak.js')
  const w = { start: '09:00', end: '23:00' }
  // 本地 12:00 在窗内 → 下一跳=出峰 23:00(本地)=UTC 15:00
  assert.equal(nextPeakTransition(utc(2026, 1, 15, 4, 0), w, TZ)?.getTime(), Date.UTC(2026, 0, 15, 15, 0))
  // 本地 08:00 在窗外 → 下一跳=进峰 09:00(本地)=UTC 01:00
  assert.equal(nextPeakTransition(utc(2026, 1, 15, 0, 0), w, TZ)?.getTime(), Date.UTC(2026, 0, 15, 1, 0))
  // 跨零点窗 22:00–06:00,本地次日 04:00 在窗内 → 下一跳=出峰 06:00=UTC 22:00(同日)
  assert.equal(nextPeakTransition(utc(2026, 1, 15, 20, 0), { start: '22:00', end: '06:00' }, TZ)?.getTime(), Date.UTC(2026, 0, 15, 22, 0))
  assert.equal(nextPeakTransition(utc(2026, 1, 15, 4, 0), { start: '00:00', end: '00:00' }, TZ), undefined)
})

test('task-queue canStart: held 任务不占位不堵队（非严格 FIFO），谓词翻转+pump 放行', async () => {
  const { createTaskQueue } = await import('../lib/task-queue.js')
  let peak = true
  const order = []
  const q = createTaskQueue({
    limit: () => 3,
    // 与 index.ts taskHeld 同型：高峰中非 bypass 的 digest/topic 挂起；fetch 放行（holdInPeak 显式挂）
    canStart: (t) => !peak || t.peakBypass === true || (t.kind === 'fetch' && t.holdInPeak !== true),
    log: silentLog,
  })
  const hang = deferred().p // 跑着的任务不收尾——验证 held 不占位、出峰放行
  q.enqueue({ id: 'digest', kind: 'digest', label: 'D', queuedAt: 1, start: () => { order.push('d'); return hang } })
  q.enqueue({ id: 'topic:x', kind: 'topic', label: 'T', queuedAt: 2, peakBypass: true, start: () => { order.push('t'); return hang } })
  q.enqueue({ id: 'fetch', kind: 'fetch', label: 'F', queuedAt: 3, start: () => { order.push('f'); return hang } })
  q.enqueue({ id: 'fetch2', kind: 'fetch', label: 'F2', queuedAt: 4, holdInPeak: true, start: () => { order.push('f2'); return hang } })
  assert.equal(q.isQueued('digest'), true)   // 高峰中 digest 挂起（不占 running 槽）
  assert.equal(q.isQueued('fetch2'), true)   // holdInPeak 的 fetch 也挂起
  assert.equal(q.isRunning('topic:x'), true) // peakBypass 立即开跑
  assert.equal(q.isRunning('fetch'), true)   // fetch 高峰放行
  await tick(); assert.deepEqual(order.sort(), ['f', 't'])
  peak = false; q.pump()                     // 出峰：digest 放行（第 3 槽）；fetch2 被同类互斥仍等
  assert.equal(q.isRunning('digest'), true)
  assert.equal(q.isQueued('fetch2'), true)
  await tick()
  assert.equal(order.includes('d'), true)
})

test('normalizePrefs: peak 字段消毒——合法 HH:MM 保留,坏值剔除,全空清除', async () => {
  const { normalizePrefs } = await import('../lib/core/prefs.js')
  assert.deepEqual(normalizePrefs({ peak: { enabled: true, start: '09:00', end: '23:00', brief: true } }).peak, { enabled: true, start: '09:00', end: '23:00', brief: true })
  assert.deepEqual(normalizePrefs({ peak: { start: 'bad', end: '23:00' } }).peak, { enabled: false, end: '23:00', brief: false }) // 坏 start 剔除,end 保留
  assert.equal(normalizePrefs({}).peak, undefined)
  assert.equal(normalizePrefs({ peak: {} }).peak, undefined)
  assert.equal(normalizePrefs({ peak: { start: '09:00', end: '23:00', brief: 'yes' } }).peak?.brief, false) // 非布尔收紧
})

test('scheduler: shouldDeferDigest 命中→跳过日报+回调,不卡 scheduledRunning 闩锁', async () => {
  const { startScheduler } = await import('../lib/scheduler.js')
  const { zonedDayKey } = await import('../lib/core/time.js')
  const timeouts = []
  const timers = { timeout(fn) { timeouts.push(fn); return () => {} }, interval() { return () => {} } }
  let digests = 0, deferred = 0
  startScheduler(timers, {
    fetch: { enabled: false, intervalMinutes: 0, onStartup: false, fetchTimes: [] },
    dailyTime: '09:00', timezone: '', catchUpHours: 0, enabled: true,
    lastDigestDay: () => zonedDayKey(new Date(), undefined), // 今天已有→不触发 catch-up
    runFetchCycle: async () => ({}), runDailyDigest: async () => { digests++ },
    getSchedule: () => ({ digestTimes: ['12:00'], fetchTimes: [] }),
    shouldDeferDigest: () => true,
    onDigestDeferred: () => { deferred++ },
    log: silentLog,
  })
  assert.equal(timeouts.length, 1) // armNext 挂的第一跳（fetchTimes 空→doDigest 定时）
  timeouts[0]()                    // 手动拨表到点
  await tick(); await tick()
  assert.equal(digests, 0)         // 日报被推迟没跑
  assert.equal(deferred, 1)        // onDigestDeferred 记了 defer
  assert.ok(timeouts.length >= 2)  // finally 里 armNext 重新挂钟——scheduledRunning 闩锁没卡住
  timeouts[1]()                    // 再到点仍推迟（高峰未过），链路可反复触发
  await tick(); await tick()
  assert.equal(deferred, 2); assert.equal(digests, 0)
})

test('slotBriefWindow: 槽=最近抓取批次→[lastFetch, now]；无抓取/太旧/未来时槽=此刻', async () => {
  const { slotBriefWindow } = await import('../lib/core/peak.js')
  const now = '2026-11-14T12:15:00.000Z'
  // 12:04 抓的、12:15 排队 → 槽=那批
  assert.deepEqual(slotBriefWindow('2026-11-14T12:04:09.198Z', now), { start: '2026-11-14T12:04:09.198Z', end: now })
  // 91min 前抓的→太旧不当"当前这批"，槽=此刻（快报自然空）
  assert.deepEqual(slotBriefWindow('2026-11-14T10:44:00.000Z', now), { start: now, end: now })
  // 从未抓过/坏值 → 槽=此刻
  assert.deepEqual(slotBriefWindow(undefined, now), { start: now, end: now })
  assert.deepEqual(slotBriefWindow('not-a-date', now), { start: now, end: now })
  // lastFetch 在未来（时钟漂移）→ 槽=此刻，不产生负窗口
  assert.deepEqual(slotBriefWindow('2026-11-14T13:00:00.000Z', now), { start: now, end: now })
})

test('scheduler: 出峰后 shouldDeferDigest=false → 日报正常跑', async () => {
  const { startScheduler } = await import('../lib/scheduler.js')
  const { zonedDayKey } = await import('../lib/core/time.js')
  const timeouts = []
  const timers = { timeout(fn) { timeouts.push(fn); return () => {} }, interval() { return () => {} } }
  let digests = 0, peak = true
  startScheduler(timers, {
    fetch: { enabled: false, intervalMinutes: 0, onStartup: false, fetchTimes: [] },
    dailyTime: '09:00', timezone: '', catchUpHours: 0, enabled: true,
    lastDigestDay: () => zonedDayKey(new Date(), undefined),
    runFetchCycle: async () => ({}), runDailyDigest: async () => { digests++ },
    getSchedule: () => ({ digestTimes: ['12:00'], fetchTimes: [] }),
    shouldDeferDigest: () => peak,
    onDigestDeferred: () => {},
    log: silentLog,
  })
  peak = false
  timeouts[0]()
  await tick(); await tick()
  assert.equal(digests, 1)
})
