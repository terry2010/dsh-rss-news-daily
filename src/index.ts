/**
 * dsh-rss-news-daily 插件入口。
 *
 * 契约（cordis bundle）：
 *  - name    'rss-news-daily'（cordis.patch.yml 里 id 必须一致）
 *  - inject  ['timer','tools']（静态依赖；webServer/llm 为可选能力走 ctx.inject）
 *  - Config  Schemastery schema（src/config.ts）
 *  - apply   挂载点：store → fetcher → tools → scheduler
 *
 * 会话零注入：apply 只注册工具/定时器/路由，不写 systemPrompt、不发 followup。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { TimerSeam } from './scheduler.js'

import { Config } from './config.js'
import type { Config as ConfigType } from './config.js'
import { Store } from './core/store.js'
import { PrefsStore } from './core/prefs.js'
import { createFetcher } from './core/fetcher.js'
import { effectiveSources, runFetchCycle, addSource, previewSource, removeSource, restoreBuiltinSource, setSourceEnabled, setSourceSummarize, updateSource, importOpml, exportOpml } from './service.js'
import { startScheduler } from './scheduler.js'
import { registerTools } from './tools.js'
import type { NewsService } from './tools.js'
import { runDailyDigest, scoreNewItems, appendHourlyBrief, textLooksForeign, zhTitleOf } from './digest-pipeline.js'
import { DshLlmClient, llmCallAvgMs, llmQueueSnapshot, setDevLogDir, setDevLogEnabled, setLlmConcurrency, setLlmDiagFile, setLlmDurPersistence, setLlmDurState, setLoopGuardEnabled } from './dsh-llm.js'
import type { LlmClient } from './summarizer.js'
import type { FeedItem, FetchCycleResult } from './core/types.js'
import { inBlocklist, isShortLead, leadKey, truncateCodePoints } from './core/parser.js'
import { listTopics, newTopicId, queryTopicCandidatesA, runTopicPipeline, topicKeyOf, upsertTopicMeta } from './topic-pipeline.js'
import type { TopicMeta, TopicParams } from './topic-pipeline.js'
import { mountApi } from './api.js'
import { parseTune } from './core/tune.js'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { digestFileName } from './digest.js'
import { applyPendingRestore, backupDirOf, runBackupZip } from './backup.js'
import { desktopNotify } from './notify.js'
import { normalizeUrl } from './service.js'
import { learnFromFeedback } from './core/tune.js'
import { zonedDayKey, zonedDayBounds } from './core/time.js'
import { scoreAndSelect } from './core/scorer.js'
import { probeSqlite, SqliteStore } from './core/sqlite-store.js'
import { addTokenStats } from './core/token-stats.js'
import { createTaskQueue } from './task-queue.js'
import { isPeak, nextPeakTransition, peakRangeValid } from './core/peak.js'
import { briefDue, briefFileOf, briefWindowStart, nextBriefMs, resolveBriefTypes } from './brief-types.js'
import type { BriefType } from './brief-types.js'

export { Config }

export const name = 'rss-news-daily'

/** 静态依赖：定时调度与模型工具——缺了核心不成立。
 *  webServer/llm 走 ctx.inject 可选声明（无 webServer 的 headless profile 也要能加载）。 */
export const inject = ['timer', 'tools']

interface BuiltinSourcesFile {
  schema: number
  sources: Array<{ name: string; url: string; defaultEnabled?: boolean }>
}

function loadBuiltinSources(): BuiltinSourcesFile {
  const file = join(fileURLToPath(new URL('.', import.meta.url)), 'sources.builtin.json')
  return JSON.parse(readFileSync(file, 'utf8')) as BuiltinSourcesFile
}

function resolveDataDir(configured: string): string {
  if (configured) return configured
  const home = process.env.DSH_HOME
  if (home) return join(home, 'data', 'rss-news-daily')
  return join(process.env.HOME || '.', '.dsh', 'rss-news-daily')
}

export function apply(ctx: Context, config: ConfigType) {
  const log = ctx.logger('rss-news-daily')
  if (!config.enabled) {
    log.info('disabled by config; loaded inert')
    return
  }
  // undici/Node 已知 bug：中止在飞 HTTP 请求（取消任务、超时）时 socket 竞态——writeH1 对已销毁 fd
  // 调 setTypeOfService 抛 EINVAL，异常发生在 socket 事件回调里，逃出所有 async catch 直达
  // uncaughtException 把宿主弹崩。窄签名守卫：只吞这个签名（socket 已死，吞了无副作用），
  // 其余错误 rethrow 保持默认崩溃语义。挂 globalThis 防插件重载重复注册。
  {
    const g = globalThis as { __rndUndiciGuard?: { log: (m: string) => void } }
    if (!g.__rndUndiciGuard) {
      g.__rndUndiciGuard = { log: (m) => console.warn(m) }
      process.on('uncaughtException', (err: Error) => {
        if (err?.message?.includes('setTypeOfService')) { g.__rndUndiciGuard?.log(`suppressed undici abort-race crash: ${err.message}`); return }
        throw err
      })
    }
    g.__rndUndiciGuard.log = (m) => log.warn(m)
  }
  const dataDir = resolveDataDir(config.dataDir)
  const pkgVersion = (() => { try { return (JSON.parse(readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'package.json'), 'utf8')) as { version?: string }).version } catch { return undefined } })()
  setLlmDiagFile(join(dataDir, 'llm.log')) // LLM 每次调用落一行：死循环/空回复排查证据
  setLoopGuardEnabled(() => prefs.get().loopGuard !== false) // 用户显式关才停；装了 loop-recover 默认开
  const devlogDir = join(dataDir, 'devlog')
  setDevLogDir(devlogDir) // 完整 prompt/response 只在 prefs.devLog 开启时写
  // 启动时间线打点：定位冷启动占位屏的真实空档。默认关闭——只有 prefs.devLog 或 DSH_BOOT_DEBUG=1 时才写 devlog/boot.log，发布版客户机器不落盘
  const bootT0 = Date.now()
  const bootLogFile = join(devlogDir, 'boot.log')
  const bootPending: string[] = []
  let bootOn: boolean | undefined // undefined = prefs 未就绪，先缓存行
  const bootMark = (mark: string) => {
    const line = `${new Date().toISOString()} +${Date.now() - bootT0}ms ${mark}`
    if (bootOn === undefined) { bootPending.push(line); return }
    if (!bootOn) return
    try { appendFileSync(bootLogFile, line + '\n') } catch { /* 目录未就绪忽略 */ }
  }
  const bootSetEnabled = (on: boolean) => {
    if (on === bootOn) return
    bootOn = on
    if (!on) { bootPending.length = 0; return }
    try {
      mkdirSync(devlogDir, { recursive: true })
      writeFileSync(bootLogFile, bootPending.join('\n') + (bootPending.length ? '\n' : ''))
      bootPending.length = 0
    } catch { /* ignore */ }
  }
  bootMark('apply enter')
  setDevLogEnabled(() => prefs.get().devLog === true)
  setLlmConcurrency(() => prefs.get().llmConcurrency ?? 1) // 全局 AI 并发：默认 1 全串行，改设置即生效
  const probe = probeSqlite()
  if (!probe.ok) throw new Error('node:sqlite unavailable in this host (requires Node >=22.5)')
  if (!probe.fts) log.warn('SQLite FTS5/trigram unavailable in this host; search falls back to LIKE')
  applyPendingRestore(dataDir, log) // 上次请求过恢复：开库前整体覆盖写回
  const uiActive = { apiAt: 0, gestureAt: 0 } // 双戳：apiAt=页面开着的心跳（statusbar 2s 轮询）；gestureAt=真实手势——开页面挂机≠在用
  const store = new SqliteStore({
    path: join(dataDir, 'store.db'), maxItems: () => prefs.get().digestOpts?.storeMaxItems ?? config.fetch.maxStoredItems, log,
    windowItems: 30_000, // 内存工作集硬顶——与库配额解耦：storeMaxItems 调再大，窗口也只背最近 3 万条
    retentionDays: () => prefs.get().digestOpts?.retentionDays ?? 90,
    pruneLowQuality: () => prefs.get().digestOpts?.pruneLowQuality ?? true,
    fts: probe.fts,
    // 每日 integrity_check 只在真·空闲时跑：任务队列全空，且（页面已关 >15s 无请求，或页面挂机 >15min 无手势）——闭包惰性读 taskQ/uiActive
    isIdle: () => taskQ.runningList().length === 0 && taskQ.waitingCount() === 0
      && (Date.now() - uiActive.apiAt > 15_000 || Date.now() - uiActive.gestureAt > 15 * 60_000),
  })
  const prefs = new PrefsStore(join(dataDir, 'prefs.json'), log)
  // ---- 高峰时段暂停：窗口内只抓取不调 AI；推迟的工作记 store.meta.peakDefer，出峰补跑 ----
  const peakCfg = () => prefs.get().peak
  const peakNow = () => { const p = peakCfg(); return p?.enabled === true && isPeak(new Date(), { start: p.start ?? '', end: p.end ?? '' }, config.timezone || undefined) }
  /** 任务是否被高峰挂起：digest/topic 默认挂（peakBypass 豁免），fetch 默认放行（AI 段由管线自己跳），holdInPeak 显式挂 */
  const taskHeld = (t: { kind: 'fetch' | 'digest' | 'topic'; peakBypass?: boolean; holdInPeak?: boolean }) =>
    peakNow() && !t.peakBypass && (t.kind !== 'fetch' || t.holdInPeak === true)
  // 全局任务队列：抓取/日报/专题按「任务」排队，同时在跑的任务数 = llmConcurrency；
  // 满了进 FIFO 等位——不再让各管线的单次 LLM 调用在调用级信号量里互相交错
  const taskQ = createTaskQueue({
    limit: () => prefs.get().llmConcurrency ?? 1,
    canStart: (t) => !taskHeld(t), // 高峰挂起的任务留在等待队列，出峰 pump 放行
    log,
  })
  const fetcher = createFetcher({
    proxyUrl: () => (prefs.get() as { proxyUrl?: string }).proxyUrl || config.fetch.proxyUrl,
    timeoutMs: config.fetch.requestTimeoutMs,
    sizeLimitBytes: config.fetch.sizeLimitBytes,
    retries: config.fetch.retries,
  })
  const sources = effectiveSources(config.sources, store)
  const enabledCount = sources.filter((s) => s.enabled).length
  let fetchProg = { running: false, done: 0, total: 0, stage: '', current: '' }
  let digestProg = { running: false, done: 0, total: 0, stage: '' }
  // ---- 进度 ETA：优先本轮实测速率（自动吸收并发/排队），冷启动退 purpose EMA；非 LLM 阶段无兜底只认实测 ----
  const etaClock = new Map<string, { stage: string; t0: number; done0: number }>()
  const progressEta = (key: string, p: { running: boolean; done: number; total: number; stage: string },
    opts: { purpose?: string | null; tail?: () => number } = {}): number | undefined => {
    if (!p.running || !p.total) { etaClock.delete(key); return undefined }
    let cur = etaClock.get(key)
    if (!cur || cur.stage !== p.stage) etaClock.set(key, (cur = { stage: p.stage, t0: Date.now(), done0: p.done }))
    const made = p.done - cur.done0 // 本阶段内已完成的单位数
    const left = Math.max(0, p.total - p.done)
    const tail = opts.tail?.() ?? 0
    if (made >= 1) return Math.max(0, Math.round(left * ((Date.now() - cur.t0) / made) + tail))
    if (opts.purpose === null) return tail > 0 ? Math.round(tail) : undefined
    const avg = opts.purpose ? llmCallAvgMs(opts.purpose) : llmCallAvgMs()
    return avg == null ? (tail > 0 ? Math.round(tail) : undefined) : Math.round(left * avg + tail)
  }
  const FETCH_STAGE_PURPOSE: Record<string, string | null> = { fetch: null, score: 'score', judge: 'judge', translate: 'translate' } // fetch 是网络抓取：非 LLM 阶段不给模型均值兜底
  const fetchEta = () => progressEta('fetch', fetchProg, { purpose: FETCH_STAGE_PURPOSE[fetchProg.stage] ?? null })
  // 阶段→EMA 桶：cluster/score/summaries/translate 各有自己的耗时画像；finishing 用尾巴估算
  const DIGEST_STAGE_PURPOSE: Record<string, string> = { cluster: 'cluster', score: 'score', summaries: 'item-summary', translate: 'translate' }
  const digestEta = () => progressEta('digest', digestProg, digestProg.stage === 'finishing'
    ? { purpose: null, tail: () => llmCallAvgMs('digest-prose') ?? llmCallAvgMs() ?? 0 }
    : { purpose: DIGEST_STAGE_PURPOSE[digestProg.stage] ?? 'item-summary' })
  const topicTailEst = () => (llmCallAvgMs('topic-merge') ?? llmCallAvgMs() ?? 0) + (llmCallAvgMs('topic-title') ?? 0)
  const topicEta = () => progressEta('topic', topicProg, topicProg.stage === 'chunks'
    ? { purpose: 'topic-chunk', tail: topicTailEst }
    : { purpose: null, tail: topicTailEst })
  // ---- LLM 队列归属：三条管线各自的客户端 tag 集合——进度端据此显示「排队等待中」而非干等 ----
  const FETCH_QUEUE_TAGS = ['brief', 'brief-translate', 'score', 'stub-judge', 'translate', 'classify']
  const DIGEST_QUEUE_TAGS = ['digest', 'digest-translate']
  const TOPIC_QUEUE_TAGS = ['topic']
  let topicProg = { running: false, done: 0, total: 0, stage: '', id: '' }
  let fetchAbort: AbortController | undefined
  let fetchCancelled = false // 「停止」请求标记：进度接口透出，前端区分"已取消"与"已完成"
  let digestCancelled = false
  log.info(
    `loaded: ${sources.length} sources (${enabledCount} enabled) digestItems=${config.digest.digestItems} `
    + `dailyTime=${config.dailyTime} tz=${config.timezone || 'host-local'} dataDir=${dataDir}`,
  )

  const makeFetchOpts = (sources?: ReturnType<typeof effectiveSources>) => ({
    fetch: fetcher,
    store,
    onSourceStart: (src: { url: string }) => { fetchProg.current = src.url },
    onSourceDone: () => { fetchProg.done += 1 },
    sources: sources ?? effectiveSources(config.sources, store), // 每轮重取：用户改源/健康度实时生效
    maxItemsPerSource: config.fetch.maxItemsPerSource,
    storeContentChars: config.fetch.storeContentChars,
    concurrency: config.fetch.concurrency,
    dedupeThreshold: config.dedupe.threshold,
    dedupeWindowDays: config.dedupe.windowDays,
    log,
  })
  // token 用量分账：把 client.usage 累计进 meta.tokenStats（按日+按功能，实现在 core/token-stats）
  const addTokens = (feature: 'digest' | 'score' | 'translate' | 'topic', usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }) =>
    addTokenStats(store.meta, feature, usage, zonedDayKey(new Date(), config.timezone || undefined))
  // P1+P8：评分+快报——fetch 完成后 fire-and-forget（调度/手动路径共用，不阻塞 fetch 返回）
  let scoringInFlight = false // 闩锁：与 digest rescoreMissing 互斥，防同批双评
  // 「仍然执行」等显式意图被同 id dup 合并时的暂存：force 由下一个起抓的任务消费（先到先得）
  const pendingFetch = { force: false }
  const dbgScore = (phase: string, extra?: Record<string, unknown>) => {
    try {
      writeFileSync(join(dataDir, 'score-debug.json'), JSON.stringify({
        at: new Date().toISOString(), phase, scoringInFlight, ...extra,
      }, null, 1))
    } catch { /* 调试写盘失败不影响主流程 */ }
  }
  // ---- 快报类型：prefs.briefTypes 未配置时虚拟内置「时段快报」（旧 hourlyBrief 开关/minScore 合成种子，频率=每整点） ----
  const briefTypesOf = (): BriefType[] => resolveBriefTypes(prefs.get(), {
    enabled: prefs.get().digestOpts?.hourlyBrief ?? config.fetch.hourlyBrief,
    minScore: config.fetch.hourlyMinScore,
  })
  /** 各类型上次运行时刻台账（typeId → ISO）：槽位覆盖判定与候选窗口起点；持久在 store.meta.briefRuns */
  const briefRuns = () => (store.meta.briefRuns ??= {})
  // 桌面通知的点击目标：desktop 走 dsh://open 深链唤起主窗口（pending-view.json
  // 让 client.js 自动切到快报视图）；web 走浏览器直达阅读器 ?kind=hourly；
  // headless（无 webServer）只有通知没有点击。
  // desktop 判别：桌面版宿主由 Electron main 以 ELECTRON_RUN_AS_NODE=1 + ipc
  // spawn 拉起（dsh-desktop-host）；`dsh web`/CLI 两者皆无 → 浏览器直达。
  let wsGetOrigin: (() => string) | undefined
  const isDesktopHost = () =>
    process.env.ELECTRON_RUN_AS_NODE === '1' || (process as { connected?: boolean }).connected === true
  const pendingViewFile = join(dataDir, 'pending-view.json')
  const notifyBrief = (hm: string, brief: string, name = '时段快报') => {
    if (!prefs.get().notifyDesktop) return
    let click: { url?: string; flagFile?: string } = {}
    if (isDesktopHost()) {
      // pending-view.json 由 helper 在「点击时」写——通知弹出只展示，
      // 真点下去才让 client.js 切快报视图，不打断用户当前操作。
      click = { url: 'dsh://open', flagFile: pendingViewFile }
    } else {
      try { const o = wsGetOrigin?.(); if (o) click = { url: `${o.replace(/\/+$/, '')}/dsh-rss-news-daily/?kind=hourly` } } catch { /* 未 listen 则无点击 */ }
    }
    desktopNotify(`📰 ${hm} ${name}`, brief.replace(/\s+/g, ' ').slice(0, 500), click)
  }
  // en-GB + hour12:false 的 ICU 怪癖：子夜时段可能产 '24:04'（time.ts 的 readParts/minutesOfDay 均已 %24 防御）。
  // 这里用 formatToParts 重建并取模——'24:04' 落成 '00:04'，否则节标题/槽位标签/同刻覆盖全错位。
  const hmOf = (d: Date) => {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone || undefined }).formatToParts(d)
    const h = String(Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24).padStart(2, '0')
    return `${h}:${parts.find((p) => p.type === 'minute')?.value ?? '00'}`
  }
  // 按快报类型写一节：文件/节名/源/关键字/分数/条数/重点全部来自 BriefType；
  // opts.noTranslate：高峰快报用——只省翻译；概括/评分照样调 AI（峰内快报是正式质量，标「高峰·未译」）
  // opts.heuristicScores：llmScore 未评出的条目启发式兜底入选（高峰/评分关时的兜底）
  const appendBriefFor = async (t: BriefType, items: FeedItem[], signal?: AbortSignal, opts?: { noTranslate?: boolean; heuristicScores?: boolean }) => {
    const now = new Date()
    const day = zonedDayKey(now, config.timezone || undefined)
    const hm = hmOf(now)
    const digestsDir = join(dataDir, 'digests')
    await appendHourlyBrief({
      items,
      sourcesById: new Map(effectiveSources(config.sources, store).map((src) => [src.id, { title: src.title }])),
      day, time: hm,
      minScore: t.minScore,
      digestsDir, log,
      file: briefFileOf(digestsDir, t, day),
      head: `# ${t.name} · ${day}\n\n`,
      sectionName: t.name,
      sourceIds: t.sourceIds, keywords: t.keywords, maxItems: t.maxItems, focus: t.focus,
      // 概括 client 与 noTranslate 解耦：峰内快报也要 AI 概括（用户明示「需要调用ai只是不翻译」）
      llmClient: llmRuntime ? new DshLlmClient(llmRuntime, pickRoute(), log, 'brief') : undefined,
      translateClient: llmRuntime && !opts?.noTranslate ? new DshLlmClient(llmRuntime, pickTranslateRoute(), log, 'brief-translate') : undefined,
      noTranslate: opts?.noTranslate,
      heuristicScores: opts?.heuristicScores,
      summaryConcurrency: prefs.get().digestOpts?.summaryConcurrency ?? config.summary.concurrency,
      signal,
      llmTimeoutMs: config.llm.timeoutMs,
      llmMaxTokens: config.llm.maxTokens,
      onBrief: (brief) => notifyBrief(hm, brief, t.name),
    })
  }
  // 评分本体：抓取管线与快报任务共用一份 LLM 配置（scoringInFlight 防重入——快报任务撞上抓取评分时幂等跳过，
  // 其入选分键回落启发式兜底）
  const scoreItems = async (fresh: FeedItem[], signal?: AbortSignal, opts?: { ignorePeak?: boolean }) => {
    const dopts = prefs.get().digestOpts
    if (scoringInFlight || !(dopts?.scoreOnFetch ?? config.fetch.scoreOnFetch) || !config.llm.enabled || !llmRuntime) return 0
    scoringInFlight = true
    try {
      if (!signal?.aborted) fetchProg = { ...fetchProg, running: true, done: 0, total: fresh.length, stage: 'score', current: '' }
      const scoreClient = new DshLlmClient(llmRuntime!, pickRoute(), log, 'score')
      let lastWarn = ''
      const slog = Object.create(log)
      slog.warn = (m: string) => { lastWarn = m; log.warn(m) }
      const scored = await scoreNewItems(fresh, scoreClient, {
        llmTimeoutMs: config.llm.timeoutMs,
        llmScoreCandidates: prefs.get().digestOpts?.llmScoreCandidates ?? config.digest.llmScoreCandidates,
        llmMaxTokens: config.llm.maxTokens,
        prefs: prefs.get(),
        signal,
        shouldPause: opts?.ignorePeak ? undefined : () => peakNow(), // 进峰即停：块间让位，已评块保留幂等续评；峰内快报显式要分时不让位
        onScoreProgress: (done, total) => { fetchProg.done = done; fetchProg.total = total },
      }, slog)
      dbgScore('scored', { scored, lastWarn })
      addTokens('score', scoreClient.usage)
      if (scored) await store.save()
      return scored
    } catch (e) { dbgScore('error', { error: e instanceof Error ? e.message : String(e) }); log.warn(`score-on-fetch failed (items kept unscored): ${e instanceof Error ? e.message : e}`); return 0 }
    finally { scoringInFlight = false }
  }
  // 无效正文过滤：短正文（缺省 ≤10汉字/≤6英文词，阈值 prefs.stubLimits 可调）先查 prefs.contentBlocklist
  // ——命中整条 hidden；未命中走一次翻译模型的 YES/NO 判定，无效则 stubLead（列表只显标题）并把正文追加进名单
  // opts.until=槽位快报用：只判 [cycleStart, until] 窗口内的批次（峰内排队槽位不替别的槽干活）
  const judgeStubs = async (cycleStart: string, signal?: AbortSignal, opts?: { until?: string }) => {
    const p = prefs.get()
    const zh = p.stubLimits?.zh ?? 10, en = p.stubLimits?.en ?? 6
    const list = [...(p.contentBlocklist ?? [])]
    const fresh = store.items.filter((i) => i.fetchedAt >= cycleStart && (!opts?.until || i.fetchedAt <= opts.until) && !i.state.hidden)
    const pending: FeedItem[] = []
    let dirty = false, added = false
    for (const it of fresh) {
      const text = (it.summary || it.content || '').trim()
      if (!isShortLead(text, zh, en)) continue
      if (inBlocklist(text, list)) { it.state.hidden = true; dirty = true; continue }
      if (!text) { it.state.stubLead = true; dirty = true; continue } // 空正文：免判直接只显标题
      if (!it.state.stubLead && !it.state.stubJudged) pending.push(it) // stubJudged=已判有效——补跑重扫不重复送判
    }
    if (pending.length && llmRuntime) {
      // 按正文归一化分组：100 条同文只调一次 AI，结果套到全组（同题源的短正文完全一致）
      const groups = new Map<string, { text: string; items: FeedItem[] }>()
      for (const it of pending) {
        const text = (it.summary || it.content || '').trim()
        const k = leadKey(text)
        if (k.length < 2) { it.state.stubLead = true; dirty = true; continue } // 归一化近空=无信息量，免判
        const g = groups.get(k) ?? { text: text.slice(0, 300), items: [] }
        g.items.push(it); groups.set(k, g)
      }
      if (!signal?.aborted && groups.size) fetchProg = { ...fetchProg, running: true, done: 0, total: groups.size, stage: 'judge', current: '' }
      const client = new DshLlmClient(llmRuntime, pickTranslateRoute(), log, 'stub-judge')
      for (const g of groups.values()) {
        if (signal?.aborted) break
        if (peakNow()) { markPeakDefer(cycleStart); break } // 进峰即停：未判组出峰重扫（stubJudged 幂等）
        try {
          const out = await client.generateText({
            system: '判断给定"新闻正文"是否为无效内容——占位/引导/无实际信息的短文本（如"点击查看原文""视频请见原文""内容已被删除"），有实质摘要信息的判有效。只输出 YES（无效）或 NO（有效），不要解释。',
            prompt: `正文：${g.text}`,
            maxTokens: 256, // YES/NO 输出虽短，推理模型 reasoning 也要占预算
            signal,
            timeoutMs: config.llm.timeoutMs,
            purpose: 'judge',
          })
          if (/\byes\b/i.test(out)) {
            for (const it of g.items) it.state.stubLead = true
            if (!inBlocklist(g.text, list)) { list.push(g.text); added = true }
            dirty = true
          } else if (/\bno\b/i.test(out)) {
            for (const it of g.items) it.state.stubJudged = true // 判有效也落标：高峰补跑/下轮重扫不再送判
            dirty = true
          }
        } catch (e) { if (signal?.aborted) break; log.warn(`stub-judge failed: ${String((e as Error)?.message || e)}`) }
        fetchProg.done += 1
      }
    }
    if (added) prefs.save({ contentBlocklist: list })
    if (dirty) await store.save()
  }
  // autoTranslate：本轮新入库外文条目逐条翻译（手动+定时两路径共用）
  // opts.until/backlog=槽位快报用：只译 [cycleStart, until] 槽内批次、不捎带历史积压（那是抓取周期/补跑的活）
  const translateFresh = async (cycleStart: string, signal?: AbortSignal, opts?: { until?: string; backlog?: boolean }) => {
    if (!prefs.get().autoTranslate || !llmRuntime) return
    const fresh = store.items.filter((i) => i.fetchedAt >= cycleStart && (!opts?.until || i.fetchedAt <= opts.until) && !i.state.hidden && !i.state.translation && !i.aiSummary && isForeign(i))
    // 历史失败重试：translationError 且未超次数的旧条目每轮捎带一批；限量防长尾占满抓取周期
    // 外文未翻全部进重试（早退轮次不打 error 标记的条目也会搁浅——不能只挑有 error 的）
    const backlog = opts?.backlog === false ? [] : store.items
      .filter((i) => i.fetchedAt < cycleStart && !i.state.hidden && !i.state.translation && !i.aiSummary
        && (i.state.translationRetries ?? 0) < 3 && isForeign(i))
      .slice(0, 50)
    const queue = [...fresh, ...backlog]
    if (queue.length && !signal?.aborted) fetchProg = { running: true, done: 0, total: queue.length, stage: 'translate', current: '' }
    let translated = 0
    for (const it of queue) {
      if (signal?.aborted) break // 抓取/翻译共用信号；取消后不再开始下一条
      if (peakNow()) { markPeakDefer(cycleStart); break } // 进峰即停：未译条目由积压/低峰补跑接走
      try { await translateItemCore(it, signal) }
      catch (e) {
        if (signal?.aborted) break
        it.state.translationError = e instanceof Error ? e.message : String(e)
        it.state.translationRetries = (it.state.translationRetries ?? 0) + 1
      }
      fetchProg.done += 1
      translated += 1
      if (fetchProg.done % 10 === 0) void store.save()
    }
    if (queue.length) {
      await store.save()
      log.info(`autoTranslate: ${translated}/${fresh.length} items translated`)
    }
  }
  // 定时备份：单文件 rss-backup-<stamp>.zip（store.db 快照 + digests/ + prefs.json）；超额删最旧
  const runBackup = async (): Promise<string> => {
    const b = prefs.get().backup
    if (!b?.dir) return ''
    const dest = await runBackupZip(dataDir, store, backupDirOf(b.dir), b.keep ?? 7)
    ;(store.meta as { lastBackupAt?: string }).lastBackupAt = new Date().toISOString()
    log.info(`backup done: ${dest}`)
    return dest
  }
  const maybeBackup = async () => {
    const b = prefs.get().backup
    if (!b?.enabled || !b.dir) return
    const last = Date.parse((store.meta as { lastBackupAt?: string }).lastBackupAt ?? '') || 0
    const days = b.period === 'week' ? 7 : b.period === 'month' ? 30 : 1
    if (Date.now() - last >= days * 86_400_000) await runBackup().catch((e) => log.warn(`backup failed: ${e}`))
  }
  // ---- 高峰推迟台账：since=首个被跳过的周期起点（补跑窗口并集）；digest=到点日报被推迟；briefSkipped 记数仅供展示 ----
  const markPeakDefer = (cycleStart: string, extra?: { digest?: boolean; briefSkipped?: boolean }) => {
    const d = store.meta.peakDefer ??= {}
    if (!d.since || cycleStart < d.since) d.since = cycleStart
    if (extra?.digest) d.digest = true
    if (extra?.briefSkipped) d.briefSkipped = (d.briefSkipped ?? 0) + 1
    void store.save()
  }
  /**
   * 快报运行任务：一次运行 = 抓取该批类型的源并集 →（峰外）判定/翻译 → 评分 → 按各类型窗口写节。
   *  kind='fetch'：与抓取任务同类互斥——快报跑的时候抓取排队、反之亦然（fetchProg/取消语义共享）。
   *  窗口语义：某类型窗口 = [max(lastRun, 今日0点), now]——从未跑过=覆盖全天（首跑即"今日快报"）。
   *  错过的槽不补：定时到点只产当前一节，窗口把错过时段的条目一并收进本节（合并产出）。
   */
  const briefRunWork = async (types: BriefType[], manual: boolean): Promise<FetchCycleResult> => {
    const controller = new AbortController()
    fetchAbort = controller
    fetchCancelled = false
    const cycleStart = new Date().toISOString()
    store.meta.lastFetchStartedAt = cycleStart // 「本次新增」计数以本轮抓取为界（快报任务也是抓取任务）
    const empty = () => ({ startedAt: cycleStart, finishedAt: new Date().toISOString(), sources: [], totalFetched: 0, totalAdded: 0, errors: 0 })
    let result: FetchCycleResult = empty()
    try {
      // 源池 = 各类型 sourceIds 并集；任一类型不限源→全部启用源
      const all = effectiveSources(config.sources, store)
      const pool = types.every((t) => t.sourceIds.length > 0)
        ? all.filter((s) => types.some((t) => t.sourceIds.includes(s.id)))
        : all
      fetchProg = { running: true, done: 0, total: pool.filter((s) => s.enabled).length, stage: 'fetch', current: '' }
      result = await runFetchCycle({ ...makeFetchOpts(pool), force: manual, signal: controller.signal })
      if (controller.signal.aborted) return result
      // 入库即算启发式分：快报入选键/启发式兜底全靠 i.score（同 runFetchWork，CPU 零 AI）
      const day = zonedDayKey(new Date(), config.timezone || undefined)
      const freshBatch = store.items.filter((i) => i.fetchedAt >= cycleStart)
      scoreAndSelect(freshBatch, new Map(effectiveSources(config.sources, store).map((s) => [s.id, s])), freshBatch.length,
        { prefs: prefs.get(), digestDay: day })
      const inPeak = peakNow()
      if (!inPeak) {
        await judgeStubs(cycleStart, controller.signal)
        await translateFresh(cycleStart, controller.signal)
      }
      // 评分窗口 = 各类型候选窗口并集内的条目（把别周期抓进来还没评的也补上；已评幂等跳过）
      const dayStart = zonedDayBounds(day, config.timezone || undefined).after
      const runs = briefRuns()
      const winStart = types.map((t) => briefWindowStart(runs[t.id], dayStart)).sort()[0]
      const winItems = store.items.filter((i) => i.fetchedAt >= winStart && !i.state.hidden)
      if (!controller.signal.aborted) await scoreItems(winItems, controller.signal, { ignorePeak: inPeak })
      if (controller.signal.aborted) return result
      const dopts = prefs.get().digestOpts
      const doScore = (dopts?.scoreOnFetch ?? config.fetch.scoreOnFetch) && config.llm.enabled && llmRuntime
      fetchProg = { ...fetchProg, running: true, stage: 'brief', current: '' }
      for (const t of types) {
        if (controller.signal.aborted) break
        const items = store.items.filter((i) => i.fetchedAt >= briefWindowStart(runs[t.id], dayStart))
        fetchProg.current = t.name
        await appendBriefFor(t, items, controller.signal, { noTranslate: inPeak, heuristicScores: inPeak || !doScore })
        runs[t.id] = cycleStart // 台账：窗口已覆盖（空时段也记——空档说明已写进文件，下轮从本轮起点续）
      }
      await store.save()
      return result
    } finally {
      if (fetchAbort === controller) {
        fetchProg = { running: false, done: 0, total: 0, stage: '', current: '' }
        fetchAbort = undefined
      }
    }
  }
  /** 快报任务 id：同类型集去重——在跑/在排的同类任务撞车合并（dup 时窗口语义保证在排任务覆盖更新的窗口） */
  const briefTaskId = (types: BriefType[]) => `brief:${types.map((t) => t.id).sort().join('+')}`
  /**
   * 入队一次快报运行。manual=true→force 绕过冷却重试全池。
   * 定时调度：峰内默认挂起等出峰（holdInPeak=!peak.brief——「排低峰」即把该类型 AI 平移到低价时段）；
   * peak.brief=true 时峰内照跑（管线内判：评分照跑、翻译省略、节标「高峰·未译」）。
   * 手动「仍执行」peakBypass：峰内立即跑同款（用户显式要求）。
   */
  const enqueueBriefRun = (types: BriefType[], manual: boolean, opts?: { holdInPeak?: boolean; peakBypass?: boolean }): { status: string; done: Promise<FetchCycleResult> } => {
    const id = briefTaskId(types)
    let settle!: { resolve: (v: unknown) => void; reject: (e: unknown) => void }
    const done = new Promise<FetchCycleResult>((res, rej) => { settle = { resolve: res as (v: unknown) => void, reject: rej } })
    done.catch(() => {}) // 无人接的 reject 不得进 unhandledRejection（定时路径不等 done）
    const r = taskQ.enqueue({
      id, kind: 'fetch',
      label: types.length > 1 ? `快报·${types.length} 种` : `快报·${types[0]?.name ?? '快报'}`,
      queuedAt: Date.now(),
      holdInPeak: opts?.holdInPeak ?? (!manual && !peakCfg()?.brief ? true : undefined),
      peakBypass: opts?.peakBypass,
      start: () => briefRunWork(types, manual),
      cancel: () => { if (fetchAbort) { fetchAbort.abort(); fetchCancelled = true } },
      settle,
    })
    if (r === 'dup') {
      // 「仍执行」意图不随 dup 蒸发：在排同型任务被高峰挂起时补标放行（同 digestNow 的 dup 处理）
      if (opts?.peakBypass) { for (const t of taskQ.waitingList()) if (t.id === id) t.peakBypass = true; taskQ.pump() }
      const now = new Date().toISOString()
      settle.resolve({ startedAt: now, finishedAt: now, sources: [], totalFetched: 0, totalAdded: 0, errors: 0 })
    }
    return { status: r, done }
  }
  // ---- 快报调度器：每类型独立槽位（lastRun 落 meta.briefRuns）——取全部启用类型的最近到期时刻挂一只钟 ----
  let briefTimer: (() => void) | undefined
  const armBriefs = () => {
    briefTimer?.(); briefTimer = undefined
    const now = new Date()
    let best = Infinity
    for (const t of briefTypesOf()) {
      if (t.enabled === false) continue
      const ms = nextBriefMs(t, briefRuns()[t.id], now, config.timezone || undefined)
      if (ms < best) best = ms
    }
    if (!Number.isFinite(best)) return // 没有启用类型/全部停用——不挂钟
    briefTimer = (ctx as unknown as TimerSeam).timeout(() => onBriefDue(), Math.max(1_000, best))
  }
  const onBriefDue = () => {
    try {
      const now = new Date()
      const due = briefTypesOf().filter((t) => t.enabled !== false && briefDue(t, briefRuns()[t.id], now, config.timezone || undefined))
      if (due.length) void enqueueBriefRun(due, false).done.catch((e) => log.warn(`scheduled brief run failed: ${String(e)}`))
    } finally { armBriefs() }
  }
  /** prefs.briefTypes 变更后调用：重挂调度钟（增删改/启停立即生效） */
  const briefsChanged = () => armBriefs()
  // 抓取管线经全局任务队列：id 'fetch' 同类去重（定时器/手动/源重试撞车合并成一个任务）；
  // 返回的 Promise 在任务真正跑完才兑现——调度器的周期锁语义与改造前一致。
  const runFetchPool = (pool: ReturnType<typeof effectiveSources>, force = false): Promise<FetchCycleResult> => {
    let settle!: { resolve: (v: unknown) => void; reject: (e: unknown) => void }
    const doneP = new Promise<FetchCycleResult>((res, rej) => { settle = { resolve: res as (v: unknown) => void, reject: rej } })
    const r = taskQ.enqueue({
      id: 'fetch', kind: 'fetch',
      label: peakNow() ? '抓取（高峰：AI 推迟）' : '抓取+评分', queuedAt: Date.now(),
      start: () => runFetchWork(pool, force),
      cancel: () => { if (fetchAbort) { fetchAbort.abort(); fetchCancelled = true } },
      settle,
    })
    // dup（已有抓取在跑/在排）→ 立即兑现空结果：调用方语义=「本轮已有等效任务」，
    // 不能让 doneP 悬着——调度器 mkCycle 的 running 锁靠它释放。
    // 但显式意图不随 dup 蒸发：force 记进 pendingFetch，由下一个起抓的任务消费
    if (r === 'dup') {
      pendingFetch.force ||= force
      const now = new Date().toISOString()
      return Promise.resolve({ startedAt: now, finishedAt: now, sources: [], totalFetched: 0, totalAdded: 0, errors: 0 })
    }
    return doneP
  }
  const runFetchWork = (pool: ReturnType<typeof effectiveSources>, force = false) => {
    const cycleStart = new Date().toISOString()
    store.meta.lastFetchStartedAt = cycleStart // 本轮起点:「本次」实时计数以此为界
    const mergedForce = force || pendingFetch.force
    pendingFetch.force = false // force 只对本任务抓取生效：先到先得
    const controller = new AbortController()
    fetchAbort = controller
    fetchCancelled = false // 新一轮清除上轮取消标记
    fetchProg = { running: true, done: 0, total: pool.filter((s) => s.enabled).length, stage: 'fetch', current: '' }
    return runFetchCycle({ ...makeFetchOpts(pool), force: mergedForce, signal: controller.signal })
      .then(async (result) => {
        // 入库即算启发式分：高峰快报入选键/LLM 候选粗排/低质清理/专题兜底全靠 i.score——CPU 本地计算零 AI。
        // 此前只在日报管线算分 → 抓取入库恒为 0 → 启发式快报永远 0 入选（生产级 bug）
        const freshBatch = store.items.filter((i) => i.fetchedAt >= cycleStart)
        scoreAndSelect(freshBatch, new Map(effectiveSources(config.sources, store).map((s) => [s.id, s])), freshBatch.length,
          { prefs: prefs.get(), digestDay: zonedDayKey(new Date(), config.timezone || undefined) })
        if (peakNow()) {
          // 高峰：抓取后 judge/translate/score 记入 defer 出峰补跑（快报不再挂在抓取尾——按自己的槽位调度）
          markPeakDefer(cycleStart)
        } else {
          await judgeStubs(cycleStart, controller.signal)
          await translateFresh(cycleStart, controller.signal)
          await scoreItems(store.items.filter((i) => i.fetchedAt >= cycleStart), controller.signal)
        }
        void maybeBackup()
        return result
      })
      .finally(() => {
        if (fetchAbort === controller) {
          fetchProg = { running: false, done: 0, total: 0, stage: '', current: '' }
          fetchAbort = undefined
        }
      })
  }
  // 低峰补跑：高峰 defer 的 AI 工作一次补齐——since 窗口内正文判定/翻译/评分（快报时段不补，日报另行触发）
  const peakBackfill = () => {
    const defer = store.meta.peakDefer
    if (!defer) return
    delete store.meta.peakDefer // 先清标再跑：补跑失败不连环重试（正常周期还会捞新条目）
    void store.save()
    const since = defer.since ?? new Date(Date.now() - 24 * 3600e3).toISOString()
    taskQ.enqueue({
      id: 'peak-backfill', kind: 'fetch', label: '低峰补跑·过滤/翻译/评分', queuedAt: Date.now(),
      holdInPeak: true, // 理论到不了这（出峰才入队），防万一在峰内被 enqueue 仍挂起
      start: async () => {
        const controller = new AbortController()
        fetchAbort = controller
        fetchCancelled = false
        fetchProg = { running: true, done: 0, total: 0, stage: 'backfill', current: '' }
        try {
          await judgeStubs(since, controller.signal)
          await translateFresh(since, controller.signal)
          await scoreItems(store.items.filter((i) => i.fetchedAt >= since && !i.state.hidden), controller.signal)
        } finally {
          if (fetchAbort === controller) { fetchProg = { running: false, done: 0, total: 0, stage: '', current: '' }; fetchAbort = undefined }
        }
      },
      cancel: () => { if (fetchAbort) { fetchAbort.abort(); fetchCancelled = true } },
    })
    if (defer.digest) { log.info('peak ended: running deferred digest'); void digestNow().catch((e) => log.warn(`deferred digest failed: ${String(e)}`)) }
  }
  // 高峰边界定时器：进峰无需动作（各处惰性判定），出峰放行挂起任务+补跑
  let peakTimer: (() => void) | undefined
  const armPeak = () => {
    peakTimer?.(); peakTimer = undefined
    const p = peakCfg()
    if (p?.enabled !== true) return
    const next = nextPeakTransition(new Date(), { start: p.start ?? '', end: p.end ?? '' }, config.timezone || undefined)
    if (next) peakTimer = (ctx as unknown as TimerSeam).timeout(() => onPeakEdge(), Math.max(1000, next.getTime() - Date.now()))
  }
  const onPeakEdge = () => {
    peakTimer = undefined
    if (peakNow()) { armPeak(); if (!peakTimer) peakTimer = (ctx as unknown as TimerSeam).timeout(() => onPeakEdge(), 30_000); return } // 提早触发兜底：还在峰内 30s 后重试
    taskQ.pump() // 放行所有高峰挂起的任务
    if (store.meta.peakDefer) { log.info(`peak ended: backfilling deferred AI work since ${store.meta.peakDefer.since ?? 'n/a'}`); peakBackfill() }
    armPeak() // 挂下一次边界（明天的进峰）
  }
  /** prefs.peak 变更后调用：重挂边界定时器；若此刻已在峰外，立刻放行+补跑（用户手动关高峰也要出效果） */
  const peakChanged = () => { armPeak(); if (!peakNow()) { taskQ.pump(); if (store.meta.peakDefer) peakBackfill() } }
  const runFetch = () => runFetchPool(effectiveSources(config.sources, store))
  // 所有 LLM 调用必须带超时——本地模型半死（连接挂起不响应）会把 runFetchPool 永不 settle，
  // 调度 mkCycle 的 running 锁随之卡死，后续每轮定时抓取全部跳过（生产曾停摆 11 小时）。
  // 超时经 timeoutMs 字段由 client 在拿到并发槽位后按次生效——排队等锁不消耗超时预算。
  // 翻译核心：标签协议解析 → 统一存 '标题\n\n正文'；标签缺失回退原样
  const translateItemCore = async (item: { id: string; title: string; summary?: string; state: { translation?: string; translationError?: string; translationRetries?: number } }, signal?: AbortSignal) => {
    const client = new DshLlmClient(llmRuntime!, pickTranslateRoute(), log, 'translate')
    const text = await client.generateText({
      system: '你是翻译助手。把给定新闻标题和摘要翻译成简体中文，严格按此格式输出两行：\n标题：<译题>\n正文：<译文>\n只输出译文，不要解释。',
      prompt: `标题：${item.title}\n\n正文：${item.summary || item.title}`,
      maxTokens: config.llm.maxTokens, // 推理模型 reasoning 计入输出预算——1200 曾被思考吃光产出空回复
      signal,
      timeoutMs: config.llm.timeoutMs,
      purpose: 'translate',
    })
    addTokens('translate', client.usage) // 每条独立 client——usage 即本条用量
    const m = text.match(/标题：\s*([^\n]+)\n+(?:[\s\S]*?)正文：\s*([\s\S]+)/)
    item.state.translation = m ? `${m[1].trim()}\n\n${m[2].trim()}` : text.trim()
    delete item.state.translationError // 成功后清掉历史失败标记（换模型重试成功后不再误报失败）
  }
  // 只看标题判定：中文标题的条目不需要翻译——摘要里混英文（促销文案/型号名）
  // 不应把中文标题条目误判成外文送进翻译队列
  const isForeign = (i: { title: string; summary?: string }) => textLooksForeign(i.title)

  // LLM 自动分类：新加源时把频道标题+条目样本丢给翻译模型归到现有分类，不中返回空
  const CLASSIFY_CATS = ['AI', '科技', '国际', '开发', '科学', '财经', '产品', '社会·人文', '综合']
  const classifyFeed = async (feed: { title: string; items: { title: string }[] }): Promise<string> => {
    if (!llmRuntime) return '' // 惰性求值：函数体调用时才读 llmRuntime（声明在下方）
    const client = new DshLlmClient(llmRuntime, pickTranslateRoute(), log, 'classify')
    try {
      const text = await client.generateText({
        system: `把 RSS 源归类到这些分类之一：${CLASSIFY_CATS.join('、')}。只输出分类名，不要解释。`,
        prompt: `频道：${feed.title}\n\n条目：${feed.items.slice(0, 5).map((i) => i.title).join('；')}`,
        maxTokens: 256, // 分类输出虽短，推理模型 reasoning 也要占预算
        timeoutMs: config.llm.timeoutMs,
        purpose: 'classify',
      })
      return CLASSIFY_CATS.find((c) => text.trim().includes(c)) || ''
    } catch { return '' }
  }

  const enabledBriefTypes = () => briefTypesOf().filter((t) => t.enabled !== false)
  const runFetchForce = (force = false, onlyFailed = false, filter?: { source?: string; category?: string }) => {
    // onlyFailed：只重试失败/冷却中的启用源（「重试全部失败源」按钮）；否则默认全量
    let pool = effectiveSources(config.sources, store)
    if (onlyFailed) pool = pool.filter((s) => s.enabled && (s.health.lastError || (s.health.cooldownUntil && new Date(s.health.cooldownUntil).getTime() > Date.now())))
    // 界面筛选联动：选了源只抓该源，选了分类只抓该分类下所有源
    if (filter?.source) pool = pool.filter((s) => s.id === filter.source || s.url === filter.source)
    else if (filter?.category) pool = pool.filter((s) => s.category === filter.category)
    return runFetchPool(pool, force) // 手动抓取与定时/源重试共用进度、取消、翻译和评分流程
  } // svc/api：手动抓取可带 force 绕冷却；快报生成走 svc.runBriefNow（独立任务，不再是抓取尾产物）
  const runFetchFor = (sources: ReturnType<typeof effectiveSources>) => {
    return runFetchPool(sources)
  }

  // 对外操作门面：tools（M2）与 HTTP API（M4）共用同一组语义
  const svc: NewsService = {
    listSources: () => effectiveSources(config.sources, store),
    addSource: (o) => addSource(fetcher, store, o, o.category ? undefined : classifyFeed),
    previewSource: (o) => previewSource(fetcher, store, o, o.category ? undefined : classifyFeed),
    setEnabled: (id, en) => setSourceEnabled(store, id, en),
    setSummarize: (id, s) => {
      const cur = effectiveSources(config.sources, store).find((x) => x.id === normalizeUrl(id) || x.url === id)
      return setSourceSummarize(store, id, s, cur?.enabled ?? true)
    },
    removeSource: (id) => {
      const src = effectiveSources(config.sources, store).find((x) => x.url === id || x.id === id || x.id === normalizeUrl(id))
      return removeSource(store, src?.url || id, src?.builtin === true)
    },
    restoreSource: (url: string) => restoreBuiltinSource(store, url),
    updateSource: (id, patch) => updateSource(store, id, patch as Parameters<typeof updateSource>[2]),
    importOpml: (text) => importOpml(store, text, config.sources),
    exportOpml: () => exportOpml(store, config.sources),
    runFetch: runFetchForce,
    fetchProgress: async () => ({ ...fetchProg, running: fetchProg.running || taskQ.isKindRunning('fetch'), cancelled: fetchCancelled, etaMs: fetchEta(), queue: llmQueueSnapshot(FETCH_QUEUE_TAGS), queued: taskQ.waitingList().some((t) => t.kind === 'fetch'), held: taskQ.waitingList().some((t) => t.kind === 'fetch' && taskHeld(t)) || undefined, taskWaiting: taskQ.waitingCount() }), // isKindRunning 补位：任务进 running-map 到 start() 之间有一拍盲区（setImmediate 排水），此间 progress 仍应报忙；queued/held 按 kind 算覆盖快报/补跑任务
    translateItem: async (id) => {
      const item = store.items.find((i) => i.id === id)
      if (!item) return { ok: false, error: 'item not found' }
      if (!llmRuntime) return { ok: false, error: 'LLM 不可用' }
      await translateItemCore(item)
      await store.save()
      return { ok: true, translation: item.state.translation }
    },
    digestProgress: async () => ({ ...digestProg, running: digestProg.running || taskQ.isRunning('digest'), cancelled: digestCancelled, etaMs: digestEta(), queue: llmQueueSnapshot(DIGEST_QUEUE_TAGS), queued: taskQ.isQueued('digest'), held: taskQ.waitingList().some((t) => t.id === 'digest' && taskHeld(t)) || undefined, taskWaiting: taskQ.waitingCount() }),
    rescanStubContent: async () => { // 名单改了就回扫：命中且短正文的存量条目立刻隐藏（单向——删词条不解隐）
      const p = prefs.get()
      const list = p.contentBlocklist ?? []
      if (!list.length) return 0
      const zh = p.stubLimits?.zh ?? 10, en = p.stubLimits?.en ?? 6
      let n = 0
      for (const it of store.items) {
        if (it.state.hidden) continue
        const text = (it.summary || it.content || '').trim()
        if (text && isShortLead(text, zh, en) && inBlocklist(text, list)) { it.state.hidden = true; n++ }
      }
      if (n) { await store.save(); log.info(`stub rescan: ${n} items hidden by contentBlocklist`) }
      return n
    },
    testFetch: async (url, proxy) => {
      const d = await fetcher(url, undefined, { proxy })
      return 'error' in d ? { error: d.error } : { status: d.status, body: d.body.slice(0, 600) }
    },
    cancelFetch: async () => { // 停止键打整个 fetch 类：'fetch' + 快报任务 + 'peak-backfill'——waiting 撤队/running abort
      let hit = false
      for (const t of taskQ.waitingList()) if (t.kind === 'fetch') { taskQ.cancel(t.id); hit = true }
      for (const t of taskQ.runningList()) if (t.kind === 'fetch') { taskQ.cancel(t.id); hit = true }
      if (fetchAbort) { fetchAbort.abort(); fetchCancelled = true } // running 任务的 abort 钩子无论如何补一刀（cancel 返回非 running 时原逻辑同款兜底）
      return hit || fetchCancelled
    },
    // ---- 快报类型（今日快报列表）：列表=resolveBriefTypes（未配置=内置时段快报种子）；sel 触发一次手动运行 ----
    listBriefTypes: () => briefTypesOf(),
    runBriefNow: (sel?: string, opts?: { holdInPeak?: boolean; peakBypass?: boolean }) => {
      const enabled = enabledBriefTypes()
      const picked = !sel || sel === 'all' ? enabled : enabled.filter((t) => t.id === sel)
      if (!picked.length) return { ok: false, error: sel && sel !== 'all' ? '快报类型不存在或已停用' : '没有可生成的快报类型' }
      const r = enqueueBriefRun(picked, true, opts)
      return { ok: true, started: r.status === 'started', queued: r.status === 'queued', merged: r.status === 'dup' }
    },
    briefsChanged, // prefs.briefTypes 变更后由 api 调用：重挂调度钟
    tune: async (text) => {
      const r = parseTune(text, prefs.get())
      if (!r.ok) return { ok: false, actions: [], error: r.error }
      if (r.patch) prefs.applyTune(text, r.actions.map((a) => `${a.kind}:${a.target}`), r.patch)
      return { ok: true, actions: r.actions.map((a) => `${a.kind}:${a.target}${a.factor ? `×${a.factor}` : ''}`) }
    },
    getDigest: async (day) => {
      const d = day || zonedDayKey(new Date(), config.timezone || undefined)
      try {
        const markdown = await readFile(join(dataDir, 'digests', digestFileName(d, 'zh')), 'utf8')
        return { ok: true, day: d, markdown }
      } catch {
        return { ok: false, day: d, error: `no digest for ${d}` }
      }
    },
    regenDigest: async (force) => {
      if (peakNow()) { // 高峰中：排低峰队列立即返回——doneP 要等任务跑完，tools 调用会挂住数小时
        // doneP 必须接 catch：任务失败时 settle.reject 无人接住 = unhandledRejection 崩宿主
        void digestNow(force).catch((e) => log.warn(`peak-queued digest failed: ${String(e)}`))
        return { ok: true, queued: true, error: undefined }
      }
      const doc = await digestNow(force)
      return { ok: true, items: doc.itemCount, degraded: doc.degraded }
    },
    searchItems: (q, limit = 20) => {
      const needle = q.toLowerCase()
      return store.items
        .filter((i) => !i.state.hidden && `${i.title} ${i.summary}`.toLowerCase().includes(needle))
        .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
        .slice(0, Math.max(1, limit))
        .map((i) => ({ id: i.id, title: i.title, link: i.link, topic: i.topic, fetchedAt: i.fetchedAt, digestedDay: i.digestedDay }))
    },
    feedback: async (id, action) => {
      const item = store.items.find((i) => i.id === id)
      if (!item) return { ok: false, error: 'item not found' }
      switch (action) {
        case 'read': item.state.read = true; break
        case 'unread': item.state.read = false; break
        case 'like': item.state.liked = 1; break
        case 'dislike': item.state.liked = -1; break
        case 'unlike': item.state.liked = 0; break
        case 'hide': item.state.hidden = true; break
        case 'unhide': item.state.hidden = false; break
        default: return { ok: false, error: `unknown action: ${action}` }
      }
      await store.save()
      if (action === 'like' || action === 'dislike') {
        const { patch, learned } = learnFromFeedback(prefs.get(), item, action)
        prefs.save(patch)
        return { ok: true, learned }
      }
      return { ok: true }
    },
    retrySource: async (urlOrId) => {
      const list = effectiveSources(config.sources, store)
      const nid = normalizeUrl(urlOrId)
      const src = list.find((s) => s.id === nid || s.url === urlOrId || s.id === urlOrId)
      if (!src) return false
      const h = store.getHealth(src.id) ?? { ok: 0, fail: 0, avgMs: 0 }
      store.setHealth(src.id, { ok: h.ok, fail: h.fail, avgMs: h.avgMs, cooldownUntil: '', failStreak: 0, lastError: '' })
      // src.health 是 effectiveSources 拍的快照副本，setHealth 不回流——
      // 不同步的话 runFetchFor 的 inCooldown 过滤还会把这个源跳过（点了重试却抓不到）
      src.health = { ok: h.ok, fail: h.fail, avgMs: h.avgMs, cooldownUntil: '', failStreak: 0, lastError: '' }
      await store.save()
      // 清完锁立刻单抓这个源：后台跑（翻译+评分可能几分钟），PATCH 立即返回，
      // 前端走 /fetch-progress 轮询；健康度由 runFetchCycle 落库
      void runFetchFor([src]).catch((e) => log.warn(`retry fetch failed for ${src.id}: ${String(e)}`))
      return true
    },
    stopDigest: async () => { const r = taskQ.cancel('digest'); if (r !== 'running' && digestAbort) { digestAbort.abort(); digestCancelled = true } return true },
    // ---- AI 专题 ----
    previewTopic: async (params: TopicParams, page = 1, filterSourceId?: string) => { // 只读候选预览：同生成管线的查询路径，不调 LLM；15 条/页；filterSourceId 仅过滤展示用，源统计仍按全入文集
      const r = await queryTopicCandidatesA(store, params, config.timezone || undefined) // 异步版：关键词间让渡，预览慢查不连堵事件循环
      const byId = new Map(effectiveSources(config.sources, store).map((s) => [s.id, { title: s.title }]))
      const counts = new Map<string, number>()
      for (const it of r.items) counts.set(it.sourceId, (counts.get(it.sourceId) || 0) + 1)
      const sources = [...counts.entries()].map(([id, count]) => ({ id, title: byId.get(id)?.title || id, count }))
        .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
      const filtered = filterSourceId ? r.items.filter((it) => it.sourceId === filterSourceId) : r.items
      const pg = Math.max(1, Math.min(Math.ceil(page) || 1, Math.max(1, Math.ceil(filtered.length / 15))))
      return {
        hitCount: r.hitCount, dedupCount: r.dedupCount, capCount: r.items.length, filterCount: filtered.length,
        page: pg, pageCount: Math.max(1, Math.ceil(filtered.length / 15)), sources,
        items: filtered.slice((pg - 1) * 15, pg * 15).map((it) => ({
          id: it.id, title: zhTitleOf(it), link: it.link,
          source: byId.get(it.sourceId)?.title || it.sourceId,
          date: (it.publishedAt || it.fetchedAt || '').slice(0, 10),
          score: Math.round(topicKeyOf(it) * 10) / 10,
          dupCount: it.dupCount || 0,
        })),
      }
    },
    runTopic: async (params: TopicParams, opts?: { peakBypass?: boolean }) => {
      if (taskQ.waitingCount() >= TASK_WAIT_MAX) return { ok: false, error: `排队已满（${TASK_WAIT_MAX}）` }
      const now = new Date().toISOString()
      const meta: TopicMeta = { // queued 条目先落盘——列表立即可见，轮到它时 start() 翻 generating；重启后懒修复
        id: newTopicId(), title: truncateCodePoints(params.keywords.join('·'), 40) || '专题',
        keywords: params.keywords, from: params.from, to: params.to,
        sourceIds: params.sourceIds, focus: params.focus,
        minScore: params.minScore, maxItems: params.maxItems,
        createdAt: now, updatedAt: now,
        hitCount: 0, dedupCount: 0, itemCount: 0, usedCount: 0,
        durationMs: 0, degraded: false, excerpt: '', status: 'queued',
      }
      await upsertTopicMeta(join(dataDir, 'digests'), meta)
      const r = enqueueTopicTask(meta, opts)
      return { ok: true, id: meta.id, queued: r !== 'started', peakHeld: r !== 'started' && taskHeld({ kind: 'topic', peakBypass: opts?.peakBypass }) }
    },
    regenTopic: async (id: string, params?: TopicParams, opts?: { peakBypass?: boolean }) => { // 覆盖重生成：默认沿用 meta 参数；传 params=修改专题后按新设置重跑，同 id 重写正文
      const old = (await listTopics(join(dataDir, 'digests'), { queuedIds: taskQ.waitingIds('topic').map((t) => t.slice(6)) })).find((m) => m.id === id)
      if (!old) return { ok: false, error: 'not found' }
      if (old.status === 'generating' || old.status === 'queued') return { ok: false, error: '生成中/排队中不可重生成' }
      if (taskQ.waitingCount() >= TASK_WAIT_MAX) return { ok: false, error: `排队已满（${TASK_WAIT_MAX}）` }
      const meta: TopicMeta = {
        ...old, status: 'queued', error: undefined,
        ...(params ? { // 修改专题：新设置落 meta；排队占位标题同步换关键词
          keywords: params.keywords, from: params.from, to: params.to,
          sourceIds: params.sourceIds, focus: params.focus,
          minScore: params.minScore, maxItems: params.maxItems,
          title: truncateCodePoints(params.keywords.join('·'), 40) || '专题',
        } : {}),
        hitCount: 0, dedupCount: 0, itemCount: 0, usedCount: 0,
        durationMs: 0, degraded: false, updatedAt: new Date().toISOString(),
      }
      await upsertTopicMeta(join(dataDir, 'digests'), meta)
      const r = enqueueTopicTask(meta, opts)
      return { ok: true, id: meta.id, queued: r !== 'started', peakHeld: r !== 'started' && taskHeld({ kind: 'topic', peakBypass: opts?.peakBypass }) }
    },
    topicProgress: async () => ({ ...topicProg, running: topicProg.running || taskQ.runningList().some((t) => t.kind === 'topic'), etaMs: topicEta(), queue: llmQueueSnapshot(TOPIC_QUEUE_TAGS), queuedIds: taskQ.waitingIds('topic').map((t) => t.slice(6)), heldIds: taskQ.waitingList().filter((t) => t.kind === 'topic' && taskHeld(t)).map((t) => t.id.slice(6)), taskWaiting: taskQ.waitingCount() }),
    stopTopic: async (id?: string) => {
      const tid = id ? `topic:${id}` : (topicProg.id ? `topic:${topicProg.id}` : '')
      if (tid) {
        const r = taskQ.cancel(tid) // waiting→onCancelQueued 落 error；running→abort
        if (r !== 'none') return { ok: true, cancelled: r }
      }
      if (topicProg.running) { // 无控制器却在"跑"＝发射台同步抛错残留：就地修复，否则该行永远挂 generating
        await listTopics(join(dataDir, 'digests')).catch(() => []) // 懒修复把非活跃 generating 落 error（含本条）
        topicProg = { running: false, done: 0, total: 0, stage: '', id: '' }
      }
      return true
    },
    dequeueTopic: (id: string) => taskQ.removeQueued(`topic:${id}`), // 删除排队项前的摘队——只动内存队列，meta 由 deleteTopic 处理
    /** 全局任务队列快照：悬停提示渲染全部在跑/排队任务（前端按 id 发 /api/task-cancel） */
    taskList: async () => {
      const progOf = (kind: string) => kind === 'fetch'
        ? { stage: fetchProg.stage, done: fetchProg.done, total: fetchProg.total, etaMs: fetchEta() }
        : kind === 'digest'
          ? { stage: digestProg.stage, done: digestProg.done, total: digestProg.total, etaMs: digestEta() }
          : { stage: topicProg.stage, done: topicProg.done, total: topicProg.total, etaMs: topicEta() }
      return {
        limit: taskQ.limit(),
        peak: peakNow() || undefined, // 高峰中标记：前端给挂起任务显示「等低峰」而非普通排队
        running: taskQ.runningList().map((t) => ({ id: t.id, kind: t.kind, label: t.label, ...progOf(t.kind) })),
        waiting: taskQ.waitingList().map((t, i) => ({ id: t.id, kind: t.kind, label: t.label, position: i + 1, held: taskHeld(t) || undefined })),
      }
    },
    cancelTask: async (id: string) => {
      const r = taskQ.cancel(id)
      if (r === 'none' && id.startsWith('topic:') && topicProg.running) { // 残留兜底同 stopTopic
        await listTopics(join(dataDir, 'digests')).catch(() => [])
        topicProg = { running: false, done: 0, total: 0, stage: '', id: '' }
      }
      return { ok: r !== 'none', cancelled: r === 'none' ? undefined : r }
    },
    peakChanged, // prefs.peak 保存后由 api 调用：重挂边界定时器+峰外立刻放行补跑
    status: (() => {
      // 两项范围 COUNT 在高摄入下本身就是大区间扫描（40万/日≈200ms）——60s 缓存摊掉 2s 轮询的常驻税
      let cntCache = { at: 0, today: 0, last: 0 }
      const refreshCounts = () => {
        const now = Date.now()
        if (now - cntCache.at < 60_000) return
        const qi = (store as { queryItems?: (o: { day?: string; fetchedAfter?: string; fetchedBefore?: string; pageSize?: number }) => { total: number } }).queryItems
        if (!qi) return
        const b = zonedDayBounds(zonedDayKey(new Date(), config.timezone || undefined), config.timezone || undefined)
        const today = qi.call(store, { day: 'x', fetchedAfter: b.after, fetchedBefore: b.before, pageSize: 1 }).total
        const since = store.meta.lastFetchStartedAt as string | undefined
        const last = since ? qi.call(store, { fetchedAfter: since, fetchedBefore: '9999-12-31', pageSize: 1 }).total : ((store.meta as { lastFetchAdded?: number }).lastFetchAdded ?? 0)
        cntCache = { at: now, today, last }
      }
      return () => {
        refreshCounts()
        const list = effectiveSources(config.sources, store)
        const failures = list.filter((s) => s.health.lastError).map((s) => ({ name: s.title, error: s.health.lastError! }))
        return {
          sources: list.length,
          enabled: list.filter((s) => s.enabled).length,
          items: (store as { count?: () => number }).count?.() ?? store.items.length,
          todayAdded: (() => { // SQL COUNT（窗口外的也算,且不受手动删库幻影影响）；60s 缓存
            const qi = (store as { queryItems?: (o: { day?: string; fetchedAfter?: string; fetchedBefore?: string; pageSize?: number }) => { total: number } }).queryItems
            if (!qi) { const t = new Date(); t.setHours(0, 0, 0, 0); return store.items.filter((i) => new Date(i.fetchedAt).getTime() >= t.getTime()).length }
            return cntCache.today
          })(),
          lastAdded: cntCache.last,
        todayTokens: (() => { const d = store.meta.tokenStats?.days?.[zonedDayKey(new Date(), config.timezone || undefined)]; return d ? { total: d.in + d.out, digest: d.digest, score: d.score, translate: d.translate, topic: d.topic ?? 0 } : undefined })(),
        tokenStats: store.meta.tokenStats,
        version: pkgVersion,
        lastFetchAt: store.meta.lastFetchAt,
        lastDigestDay: store.meta.lastDigestDay,
        failures,
        cooling: list.filter((s) => s.health.cooldownUntil && new Date(s.health.cooldownUntil).getTime() > Date.now()).length,
        peak: (() => { // 高峰暂停状态：前端弹层/徽章/任务弹层据此前置提示
          const p = peakCfg()
          const range = { start: p?.start ?? '', end: p?.end ?? '' }
          const enabled = p?.enabled === true && peakRangeValid(range)
          const defer = store.meta.peakDefer
          return {
            enabled, active: enabled && peakNow(), start: p?.start, end: p?.end, brief: p?.brief === true,
            nextTransition: enabled ? nextPeakTransition(new Date(), range, config.timezone || undefined)?.toISOString() : undefined,
            defer: defer ? { since: defer.since, digest: defer.digest === true, briefSkipped: defer.briefSkipped ?? 0 } : undefined,
          }
        })(),
        }
      }
    })(),
  }

  let llmRuntime: ConstructorParameters<typeof DshLlmClient>[0] | undefined
  // 宿主目录选择服务（可选能力）：桌面端 = native 系统对话框；browse/无服务时 /api/pick-dir 降级
  let directoryPickerSvc: { capability?: () => { kind?: string; pick?: (s: AbortSignal) => Promise<string | null> } } | undefined
  const pickRoute = (): { provider: string; model: string } => {
    const ui = prefs.get().llm
    if (ui?.provider && ui?.model) return ui // UI 覆盖 > config 对 > 自动
    return { provider: config.llm.provider, model: config.llm.model }
  }
  const pickTranslateRoute = (): { provider: string; model: string } => {
    const t = prefs.get().translateLlm
    if (t?.provider && t?.model) return t // 翻译模型覆盖 > 日报模型 > config
    return pickRoute()
  }
  let digestAbort: AbortController | undefined // 「停止生成」：中止在飞的 LLM 调用（流逐条失败→降级收尾，不落半文件）
  let topicAbort: AbortController | undefined
  const TASK_WAIT_MAX = 16 // 全局等待队列上限（topicQueue 原有 8 条上限升级为统一闸门）
  /** 专题入队：meta 已是 queued 落盘态；start() 在拿到任务槽后翻 generating 再发射；
   *  waiting 态取消落 error「排队中已取消」（与用户手动停止的在跑取消同构——都是主动终止）。
   *  opts.peakBypass=高峰弹层「仍执行」：任务不被高峰挂起 */
  const enqueueTopicTask = (meta: TopicMeta, opts?: { peakBypass?: boolean }) => taskQ.enqueue({
    id: `topic:${meta.id}`, kind: 'topic', label: `专题·${meta.title || meta.id}`, queuedAt: Date.now(),
    peakBypass: opts?.peakBypass,
    start: () => {
      meta.status = 'generating'
      meta.updatedAt = new Date().toISOString()
      void upsertTopicMeta(join(dataDir, 'digests'), meta).catch(() => {})
      return launchTopic(meta)
    },
    cancel: () => { if (topicProg.id === meta.id) topicAbort?.abort() },
    onCancelQueued: () => {
      meta.status = 'error'; meta.error = '排队中已取消'; meta.updatedAt = new Date().toISOString()
      void upsertTopicMeta(join(dataDir, 'digests'), meta).catch(() => {})
    },
  })
  /** 专题发射台：返回管线 Promise——任务队列靠它知道任务何时真正结束再排水下一个 */
  const launchTopic = (meta: TopicMeta): Promise<unknown> => {
    const digestsDir = join(dataDir, 'digests')
    const controller = new AbortController()
    topicAbort = controller
    topicProg = { running: true, done: 0, total: 0, stage: 'candidates', id: meta.id }
    try {
      const topicClient = llmRuntime ? new DshLlmClient(llmRuntime, pickRoute(), log, 'topic') : undefined
      return runTopicPipeline({
        store,
        params: { keywords: meta.keywords, from: meta.from, to: meta.to, sourceIds: meta.sourceIds, focus: meta.focus, minScore: meta.minScore, maxItems: meta.maxItems },
        meta,
        llmClient: topicClient,
        llmEnabled: config.llm.enabled,
        summaryConcurrency: prefs.get().digestOpts?.summaryConcurrency ?? config.summary.concurrency,
        llmTimeoutMs: config.llm.timeoutMs,
        llmMaxTokens: config.llm.maxTokens,
        signal: controller.signal,
        sourcesById: new Map(effectiveSources(config.sources, store).map((s) => [s.id, { title: s.title }])),
        digestsDir,
        timezone: config.timezone,
        log,
        onProgress: (done, total, stage) => { topicProg.done = done; topicProg.total = total; topicProg.stage = stage },
      }).then((m) => {
        addTokens('topic', topicClient?.usage)
        log.info(`topic generated: ${m.id} items=${m.itemCount} used=${m.usedCount} degraded=${m.degraded}`)
      }).catch((e) => {
        const reason = controller.signal.aborted ? '手动停止' : (e instanceof Error ? e.message : String(e))
        meta.status = 'error'; meta.error = reason; meta.updatedAt = new Date().toISOString()
        void upsertTopicMeta(digestsDir, meta).catch(() => {})
        log.warn(`topic ${meta.id} failed: ${reason}`)
      }).finally(() => {
        topicAbort = undefined
        topicProg = { running: false, done: 0, total: 0, stage: '', id: '' }
      })
    } catch (e) { // 同步抛出（pickRoute 配置错等）：不留 generating 死档/假活进度——懒修复豁免在跑任务，丢了就没法救
      topicAbort = undefined
      topicProg = { running: false, done: 0, total: 0, stage: '', id: '' }
      meta.status = 'error'; meta.error = e instanceof Error ? e.message : String(e); meta.updatedAt = new Date().toISOString()
      void upsertTopicMeta(digestsDir, meta).catch(() => {})
      throw e // 上抛给任务队列——发射失败也要排水，队列不该被哑弹卡死
    }
  }
  // 日报经全局任务队列：dup 时返回兼容的降级 doc；返回的 Promise 在任务跑完才兑现（regenDigest 语义不变）。
  // opts.peakBypass=高峰弹层「仍执行」：任务不被高峰挂起
  const digestNow = (force = false, day?: string, opts?: { peakBypass?: boolean }) => {
    let settle!: { resolve: (v: unknown) => void; reject: (e: unknown) => void }
    const doneP = new Promise<Awaited<ReturnType<typeof digestRun>>>((res, rej) => { settle = { resolve: res as (v: unknown) => void, reject: rej } })
    const r = taskQ.enqueue({
      id: 'digest', kind: 'digest', label: '日报生成', queuedAt: Date.now(),
      peakBypass: opts?.peakBypass,
      start: () => runDigestWork(force, day),
      cancel: () => { if (digestAbort) { digestAbort.abort(); digestCancelled = true } },
      settle,
    })
    if (r === 'dup') {
      // 「仍然执行」意图不随 dup 蒸发：已有日报被高峰挂起时，dup 的 bypass 补标到在排任务上并放水开跑
      if (opts?.peakBypass) {
        for (const t of taskQ.waitingList()) if (t.id === 'digest') t.peakBypass = true
        taskQ.pump()
      }
      return Promise.resolve({ title: '', date: '', language: 'zh' as const, markdown: '', itemCount: 0, itemIds: [], summarySource: 'extractive' as const, degraded: true, note: 'digest already running' } as unknown as Awaited<ReturnType<typeof digestRun>>)
    }
    return doneP
  }
  const runDigestWork = (force = false, day?: string) => {
    digestAbort = new AbortController()
    digestCancelled = false // 新一轮清除上轮取消标记
    digestProg = { running: true, done: 0, total: 0, stage: '' }
    return digestRun(force, day).then((doc) => { addTokens('digest', doc.tokens); addTokens('translate', doc.translateTokens); return doc })
      .finally(() => { digestAbort = undefined; digestProg = { running: false, done: 0, total: 0, stage: '' } })
  }
  const digestRun = (force: boolean, day?: string) => runDailyDigest({
    store,
    day,
    configSources: config.sources,
    // 每次 digest 现组 client：UI 换模型后下次立即生效（resolution 缓存在 client 实例上）
    llmClient: llmRuntime ? new DshLlmClient(llmRuntime, pickRoute(), log, 'digest') : undefined,
    translateClient: llmRuntime ? new DshLlmClient(llmRuntime, pickTranslateRoute(), log, 'digest-translate') : undefined,
    llmEnabled: config.llm.enabled,
    summaryEnabled: config.summary.enabled,
    summaryMaxItems: prefs.get().digestOpts?.summaryMaxItems ?? config.summary.maxItems,
    summaryConcurrency: prefs.get().digestOpts?.summaryConcurrency ?? config.summary.concurrency,
    summaryMaxLength: config.summary.maxLength,
    digestItems: prefs.get().digestOpts?.digestItems ?? config.digest.digestItems,
    perTopicLimit: prefs.get().digestOpts?.perTopicLimit ?? config.digest.perTopicLimit,
    llmScoreCandidates: prefs.get().digestOpts?.llmScoreCandidates ?? config.digest.llmScoreCandidates,
    candidateMax: prefs.get().digestOpts?.candidateMax,
    subscribedTopics: prefs.get().subscribedTopics,
    rescoreMissing: !scoringInFlight && (prefs.get().digestOpts?.rescoreMissing ?? config.digest.rescoreMissing),
    minLlmScore: prefs.get().digestOpts?.minLlmScore ?? config.digest.minLlmScore,
    candidateHours: prefs.get().digestOpts?.candidateHours ?? undefined,
    dedupeStories: config.digest.dedupeStories,
    categoryPrompts: config.digest.categoryPrompts,
    digestMaxLength: prefs.get().digestOpts?.digestMaxLength ?? config.digest.maxLength,
    llmTimeoutMs: config.llm.timeoutMs,
    signal: digestAbort?.signal,
    onItemDone: (done, total, stage) => { digestProg.done = done; digestProg.total = total; digestProg.stage = stage || '' },
    llmMaxTokens: config.llm.maxTokens,
    language: 'zh',
    timezone: config.timezone,
    digestsDir: join(dataDir, 'digests'),
    prefs: prefs.get(), // 每次取当前值：M5 调教立即生效于下一次打分
    penaltyWindowDays: config.dedupe.windowDays,
    force,
    log,
  }).then((doc) => {
    log.info(`digest written: ${doc.date} ${doc.itemCount} items degraded=${doc.degraded}`)
    // macOS 通知（可选，fire-and-forget，失败静默——通知是锦上添花不是关键路径）
    if (config.notifyEnabled) {
      const top = store.items.filter((i) => doc.itemIds.includes(i.id)).slice(0, config.notifyMaxTitles)
        .map((i) => i.title).join('；')
      execFile('osascript', ['-e',
        `display notification ${JSON.stringify(`${doc.itemCount} 条精选 ${top.slice(0, 120)}`)} with title ${JSON.stringify(doc.title)}`],
        () => {})
    }
    return doc
  })

  let disposed = false
  const disposers: Array<() => void> = []
  void store.load()
    .then(() => {
      if (disposed) return
      bootMark('store.load resolved')
      prefs.load()
      bootSetEnabled(prefs.get().devLog === true || process.env.DSH_BOOT_DEBUG === '1') // 开 devLog 偏好才落盘；发布版默认不写
      bootMark('prefs.load done')
      if (pkgVersion && store.meta.pluginVersion !== pkgVersion) store.meta.pluginVersion = pkgVersion // 记录最后打开此库的插件版本——跨版本数据形状迁移/排障依据（随下次 save 落盘）
      // EMA 跨重启续命：store.load 后灌回历史耗时画像，重启后首个任务即有 ETA；落盘随 store.save()
      setLlmDurState(store.meta.llmDurEma)
      setLlmDurPersistence({ save: (s) => { store.meta.llmDurEma = s } })
      disposers.push(() => setLlmDurPersistence(null))
      // loopGuard 首装一次性定型：此刻装了 loop-recover→勾，没装→不勾并落盘；
      // 此后不跟随安装状态变——之后装了也要用户手动开
      if (prefs.get().loopGuard === undefined) {
        const nm = dirname(fileURLToPath(new URL('../', import.meta.url)))
        const installed = existsSync(join(nm, 'dsh-loop-recover', 'package.json'))
        prefs.save({ loopGuard: installed })
        log.info(`loopGuard initialized: ${installed ? 'on (dsh-loop-recover installed)' : 'off (not installed)'}`)
      }
      disposers.push(registerTools(ctx, svc))
      disposers.push(startScheduler(ctx as unknown as TimerSeam, {
        fetch: {
          ...config.fetch,
          intervalMinutes: prefs.get().schedule?.intervalMinutes ?? config.fetch.intervalMinutes,
          onStartup: prefs.get().schedule?.onStartup ?? config.fetch.onStartup,
        },
        dailyTime: config.dailyTime,
        getSchedule: () => prefs.get().schedule ?? {
          digestTimes: config.schedule.digestTimes.length ? config.schedule.digestTimes : [config.dailyTime],
          fetchTimes: config.schedule.fetchTimes,
        },
        timezone: config.timezone,
        catchUpHours: config.catchUpHours,
        enabled: true,
        lastDigestDay: () => store.meta.lastDigestDay,
        runFetchCycle: runFetch,
        runDailyDigest: digestNow,
        shouldDeferDigest: () => peakNow(), // 高峰到点不跑日报——记 defer 出峰补（任务挂起会卡 scheduledRunning 闩锁）
        onDigestDeferred: () => markPeakDefer(new Date().toISOString(), { digest: true }),
        log,
      }))
      armPeak() // 高峰边界定时器首次挂钟
      armBriefs() // 快报类型调度首次挂钟（从未跑过的类型立即到期——首次启动即产一份快报）
      disposers.push(() => { peakTimer?.(); peakTimer = undefined }) // 插件重载必须清钟：孤儿定时器会拿旧闭包再跑一遍 pump/补跑
      disposers.push(() => { briefTimer?.(); briefTimer = undefined })
      if (store.meta.peakDefer && !peakNow()) peakBackfill() // 重启落在峰外且有欠账：直接补跑
      bootMark('tools+scheduler armed')
      log.info('tools registered, scheduler armed')
    })
    .catch((e) => log.error('store load failed; plugin degraded to inert', e))

  // 可选能力按服务逐项声明：有就用、没有就降级，绝不因缺服务而拒载。
  ctx.inject(['llm'], (c) => {
    const runtime = (c as unknown as { llm?: unknown }).llm
    if (runtime) {
      llmRuntime = runtime as ConstructorParameters<typeof DshLlmClient>[0]
      log.info('llm service available: LLM summaries enabled')
    }
  })
  ctx.inject(['directoryPicker'], (c) => {
    directoryPickerSvc = (c as unknown as { directoryPicker?: typeof directoryPickerSvc }).directoryPicker
    if (directoryPickerSvc) log.info(`directoryPicker service available: ${directoryPickerSvc.capability?.().kind ?? 'unknown'}`)
  })
  ctx.inject(['webServer'], (c) => {
    bootMark('webServer service injected')
    const ws = (c as unknown as { webServer?: { getOrigin?: () => string } }).webServer
    if (ws) {
      wsGetOrigin = typeof ws.getOrigin === 'function' ? () => ws.getOrigin!() : undefined
      disposers.push(mountApi(ws as Parameters<typeof mountApi>[0], {
        store,
        prefs,
        svc,
        configSources: config.sources,
        timezone: config.timezone,
        readerPageSize: config.readerPageSize,
        digestsDir: join(dataDir, 'digests'),
        runDigest: digestNow,
        getLlm: () => llmRuntime,
        getDirectoryPicker: () => directoryPickerSvc,
        configLlm: { provider: config.llm.provider, model: config.llm.model },
        configSchedule: {
          digestTimes: config.schedule.digestTimes.length ? config.schedule.digestTimes : [config.dailyTime],
          fetchTimes: config.schedule.fetchTimes,
        },
        devlogDir,
        briefDefaults: {
          enabled: prefs.get().digestOpts?.hourlyBrief ?? config.fetch.hourlyBrief,
          minScore: config.fetch.hourlyMinScore,
        },
        onApiHit: () => { uiActive.apiAt = Date.now() },
        onGesture: () => { uiActive.gestureAt = Date.now() },
        bootMark,
      }))
      bootMark('mountApi registered')
      log.info('reader mounted at /dsh-rss-news-daily/')
    }
  })

  // apply 返回值即 cordis 插件 disposer：卸载时停调度、反注册工具。
  return () => {
    disposed = true
    for (const d of disposers.splice(0)) {
      try { d() } catch { /* 清理失败不拖垮卸载 */ }
    }
  }
}
