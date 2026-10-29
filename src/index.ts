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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { TimerSeam } from './scheduler.js'

import { Config } from './config.js'
import type { Config as ConfigType } from './config.js'
import { Store } from './core/store.js'
import { PrefsStore } from './core/prefs.js'
import { createFetcher } from './core/fetcher.js'
import { effectiveSources, runFetchCycle, addSource, removeSource, setSourceEnabled, setSourceSummarize, updateSource, importOpml, exportOpml } from './service.js'
import { startScheduler } from './scheduler.js'
import { registerTools } from './tools.js'
import type { NewsService } from './tools.js'
import { runDailyDigest, scoreNewItems, appendHourlyBrief } from './digest-pipeline.js'
import { DshLlmClient } from './dsh-llm.js'
import type { LlmClient } from './summarizer.js'
import { mountApi } from './api.js'
import { parseTune } from './core/tune.js'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { digestFileName } from './digest.js'
import { normalizeUrl } from './service.js'
import { learnFromFeedback } from './core/tune.js'
import { zonedDayKey, zonedDayBounds } from './core/time.js'
import { probeSqlite, SqliteStore } from './core/sqlite-store.js'
import { addTokenStats } from './core/token-stats.js'

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
  const dataDir = resolveDataDir(config.dataDir)
  const probe = probeSqlite()
  if (!probe.ok) throw new Error('node:sqlite unavailable in this host (requires Node >=22.5)')
  if (!probe.fts) log.warn('SQLite FTS5/trigram unavailable in this host; search falls back to LIKE')
  const store = new SqliteStore({
    path: join(dataDir, 'store.db'), maxItems: config.fetch.maxStoredItems, log,
    retentionDays: () => prefs.get().digestOpts?.retentionDays ?? 90,
    pruneLowQuality: () => prefs.get().digestOpts?.pruneLowQuality ?? true,
    fts: probe.fts,
  })
  const prefs = new PrefsStore(join(dataDir, 'prefs.json'), log)
  const fetcher = createFetcher({
    proxyUrl: () => (prefs.get() as { proxyUrl?: string }).proxyUrl || config.fetch.proxyUrl,
    timeoutMs: config.fetch.requestTimeoutMs,
    sizeLimitBytes: config.fetch.sizeLimitBytes,
    retries: config.fetch.retries,
  })
  const sources = effectiveSources(config.sources, store)
  const enabledCount = sources.filter((s) => s.enabled).length
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
  const addTokens = (feature: 'digest' | 'score' | 'translate', usage?: { inputTokens: number; outputTokens: number }) =>
    addTokenStats(store.meta, feature, usage, zonedDayKey(new Date(), config.timezone || undefined))
  // P1+P8：评分+快报——fetch 完成后 fire-and-forget（调度/手动路径共用，不阻塞 fetch 返回）
  let scoringInFlight = false // 闩锁：与 digest rescoreMissing 互斥，防同批双评
  const scoreAndBrief = async (cycleStart: string, signal?: AbortSignal) => {
    const dopts = prefs.get().digestOpts
    const doScore = (dopts?.scoreOnFetch ?? config.fetch.scoreOnFetch) && config.llm.enabled && llmRuntime
    if (!doScore || scoringInFlight) return
    scoringInFlight = true
    try {
      const fresh = store.items.filter((i) => i.fetchedAt >= cycleStart)
      const scoreClient = new DshLlmClient(llmRuntime!, pickRoute(), log)
      const scored = await scoreNewItems(fresh, scoreClient, {
        llmTimeoutMs: config.llm.timeoutMs,
        llmScoreCandidates: dopts?.llmScoreCandidates ?? config.digest.llmScoreCandidates,
        llmMaxTokens: config.llm.maxTokens,
        prefs: prefs.get(),
        signal,
      }, log)
      addTokens('score', scoreClient.usage)
      if (scored) await store.save()
      if (dopts?.hourlyBrief ?? config.fetch.hourlyBrief) {
        const now = new Date()
        const day = zonedDayKey(now, config.timezone || undefined)
        const hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone || undefined }).format(now)
        await appendHourlyBrief({
          items: fresh,
          sourcesById: new Map(effectiveSources(config.sources, store).map((src) => [src.id, { title: src.title }])),
          day, time: hm,
          minScore: config.fetch.hourlyMinScore,
          digestsDir: join(dataDir, 'digests'), log,
        })
      }
    } catch (e) { log.warn(`score-on-fetch failed (items kept unscored): ${e instanceof Error ? e.message : e}`) }
    finally { scoringInFlight = false }
  }
  // autoTranslate：本轮新入库外文条目逐条翻译（手动+定时两路径共用）
  const translateFresh = async (cycleStart: string) => {
    if (!prefs.get().autoTranslate || !llmRuntime) return
    const fresh = store.items.filter((i) => i.fetchedAt >= cycleStart && !i.state.translation && !i.aiSummary && isForeign(i))
    if (fresh.length) { fetchProg = { running: true, done: 0, total: fresh.length, stage: 'translate', current: '' }; translateAbort = new AbortController() }
    for (const it of fresh) {
      if (translateAbort?.signal.aborted || fetchAbort?.signal.aborted) break // 抓取/翻译取消联动
      try { await translateItemCore(it) }
      catch (e) { it.state.translationError = e instanceof Error ? e.message : String(e) }
      fetchProg.done += 1
      if (fetchProg.done % 10 === 0) void store.save()
    }
    translateAbort = undefined
    if (fresh.length) { await store.save(); log.info(`autoTranslate: ${fresh.length} items translated`) }
  }
  const runFetch = () => {
    const cycleStart = new Date().toISOString()
    store.meta.lastFetchStartedAt = cycleStart // 本轮起点:「本次」实时计数以此为界
    fetchProg = { running: true, done: 0, total: effectiveSources(config.sources, store).filter((s) => s.enabled).length, stage: 'fetch', current: '' }
    return runFetchCycle(makeFetchOpts())
      .then(async (r) => { await translateFresh(cycleStart); void scoreAndBrief(cycleStart); return r })
      .finally(() => { fetchProg = { running: false, done: 0, total: 0, stage: '', current: '' } })
  }
  let fetchProg = { running: false, done: 0, total: 0, stage: '', current: '' }
  let digestProg = { running: false, done: 0, total: 0, stage: '' }
  let fetchAbort: AbortController | undefined
  let translateAbort: AbortController | undefined
  // 翻译核心：标签协议解析 → 统一存 '标题\n\n正文'；标签缺失回退原样
  const translateItemCore = async (item: { id: string; title: string; summary?: string; state: { translation?: string; translationError?: string } }) => {
    const client = new DshLlmClient(llmRuntime!, pickTranslateRoute(), log)
    const text = await client.generateText({
      system: '你是翻译助手。把给定新闻标题和摘要翻译成简体中文，严格按此格式输出两行：\n标题：<译题>\n正文：<译文>\n只输出译文，不要解释。',
      prompt: `标题：${item.title}\n\n正文：${item.summary || item.title}`,
      maxTokens: 1200,
    })
    addTokens('translate', client.usage) // 每条独立 client——usage 即本条用量
    const m = text.match(/标题：\s*([^\n]+)\n+(?:[\s\S]*?)正文：\s*([\s\S]+)/)
    item.state.translation = m ? `${m[1].trim()}\n\n${m[2].trim()}` : text.trim()
  }
  const isForeign = (i: { title: string; summary?: string }) => {
    const t = i.title + (i.summary || '')
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length
    return cjk * 2 <= t.replace(/\s/g, '').length
  }

  // LLM 自动分类：新加源时把频道标题+条目样本丢给翻译模型归到现有分类，不中返回空
  const CLASSIFY_CATS = ['AI', '科技', '国际', '开发', '科学', '财经', '产品', '社会·人文', '综合']
  const classifyFeed = async (feed: { title: string; items: { title: string }[] }): Promise<string> => {
    if (!llmRuntime) return '' // 惰性求值：函数体调用时才读 llmRuntime（声明在下方）
    const client = new DshLlmClient(llmRuntime, pickTranslateRoute(), log)
    try {
      const text = await client.generateText({
        system: `把 RSS 源归类到这些分类之一：${CLASSIFY_CATS.join('、')}。只输出分类名，不要解释。`,
        prompt: `频道：${feed.title}\n\n条目：${feed.items.slice(0, 5).map((i) => i.title).join('；')}`,
        maxTokens: 20,
      })
      return CLASSIFY_CATS.find((c) => text.trim().includes(c)) || ''
    } catch { return '' }
  }

  const runFetchForce = (force = false, onlyFailed = false, filter?: { source?: string; category?: string }) => {
    // onlyFailed：只重试失败/冷却中的启用源（「重试全部失败源」按钮）；否则默认全量
    let pool = effectiveSources(config.sources, store)
    if (onlyFailed) pool = pool.filter((s) => s.enabled && (s.health.lastError || (s.health.cooldownUntil && new Date(s.health.cooldownUntil).getTime() > Date.now())))
    // 界面筛选联动：选了源只抓该源，选了分类只抓该分类下所有源
    if (filter?.source) pool = pool.filter((s) => s.id === filter.source || s.url === filter.source)
    else if (filter?.category) pool = pool.filter((s) => s.category === filter.category)
    fetchProg = { running: true, done: 0, total: pool.filter((s) => s.enabled).length, stage: 'fetch', current: '' }
    fetchAbort = new AbortController()
    const cycleStart = new Date().toISOString()
    store.meta.lastFetchStartedAt = cycleStart
    return runFetchCycle({ ...makeFetchOpts(pool), force, signal: fetchAbort.signal, onSourceDone: () => { fetchProg.done += 1 } })
      .then(async (result) => {
        await translateFresh(cycleStart) // 自动翻译：本轮新入库外文条目（与定时路径共用）
        void scoreAndBrief(cycleStart, fetchAbort?.signal) // fire-and-forget：评分不阻塞抓取返回
        return result
      })
      .finally(() => { fetchProg = { running: false, done: 0, total: 0, stage: '', current: '' }; fetchAbort = undefined })
  } // svc/api：手动抓取可带 force 绕冷却
  const runFetchFor = (sources: ReturnType<typeof effectiveSources>) => {
    const cycleStart = new Date().toISOString()
    store.meta.lastFetchStartedAt = cycleStart
    return runFetchCycle(makeFetchOpts(sources)).then((r) => { void scoreAndBrief(cycleStart); return r })
  }

  // 对外操作门面：tools（M2）与 HTTP API（M4）共用同一组语义
  const svc: NewsService = {
    listSources: () => effectiveSources(config.sources, store),
    addSource: (o) => addSource(fetcher, store, o, o.category ? undefined : classifyFeed),
    setEnabled: (id, en) => setSourceEnabled(store, id, en),
    setSummarize: (id, s) => {
      const cur = effectiveSources(config.sources, store).find((x) => x.id === normalizeUrl(id) || x.url === id)
      return setSourceSummarize(store, id, s, cur?.enabled ?? true)
    },
    removeSource: (id) => removeSource(store, id),
    updateSource: (id, patch) => updateSource(store, id, patch as Parameters<typeof updateSource>[2]),
    importOpml: (text) => importOpml(store, text, config.sources),
    exportOpml: () => exportOpml(store, config.sources),
    runFetch: runFetchForce,
    fetchProgress: async () => ({ ...fetchProg }),
    translateItem: async (id) => {
      const item = store.items.find((i) => i.id === id)
      if (!item) return { ok: false, error: 'item not found' }
      if (!llmRuntime) return { ok: false, error: 'LLM 不可用' }
      await translateItemCore(item)
      await store.save()
      return { ok: true, translation: item.state.translation }
    },
    digestProgress: async () => ({ ...digestProg }),
    testFetch: async (url, proxy) => {
      const d = await fetcher(url, undefined, { proxy })
      return 'error' in d ? { error: d.error } : { status: d.status, body: d.body.slice(0, 600) }
    },
    cancelFetch: async () => { fetchAbort?.abort(); translateAbort?.abort(); return true },
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
      // 清完锁立刻单抓这个源：成功 health.ok 立涨，用户不用等下一轮 interval
      await runFetchFor([src]).catch((e) => log.warn(`retry fetch failed for ${src.id}: ${String(e)}`))
      return true
    },
    stopDigest: async () => { digestAbort?.abort(); return true },
    status: () => {
      const list = effectiveSources(config.sources, store)
      const failures = list.filter((s) => s.health.lastError).map((s) => ({ name: s.title, error: s.health.lastError! }))
      return {
        sources: list.length,
        enabled: list.filter((s) => s.enabled).length,
        items: (store as { count?: () => number }).count?.() ?? store.items.length,
        todayAdded: (() => { // SQL COUNT（窗口外的也算,且不受手动删库幻影影响）
          const t = new Date(); t.setHours(0, 0, 0, 0)
          const qi = (store as { queryItems?: (o: { day?: string; fetchedAfter?: string; fetchedBefore?: string; pageSize?: number }) => { total: number } }).queryItems
          const b = zonedDayBounds(zonedDayKey(new Date(), config.timezone || undefined), config.timezone || undefined)
          return qi ? qi.call(store, { day: 'x', fetchedAfter: b.after, fetchedBefore: b.before, pageSize: 1 }).total
            : store.items.filter((i) => new Date(i.fetchedAt).getTime() >= t.getTime()).length
        })(),
        lastAdded: (() => { // 上轮起点以来新增(实时,被删的不算,清库竞态自愈)
          const since = store.meta.lastFetchStartedAt as string | undefined
          const qi = (store as { queryItems?: (o: { fetchedAfter?: string; fetchedBefore?: string; pageSize?: number }) => { total: number } }).queryItems
          if (!qi || !since) return (store.meta as { lastFetchAdded?: number }).lastFetchAdded ?? 0
          return qi.call(store, { fetchedAfter: since, fetchedBefore: '9999-12-31', pageSize: 1 }).total
        })(),
        todayTokens: (() => { const d = store.meta.tokenStats?.days?.[zonedDayKey(new Date(), config.timezone || undefined)]; return d ? { total: d.in + d.out, digest: d.digest, score: d.score, translate: d.translate } : undefined })(),
        tokenStats: store.meta.tokenStats,
        version: (() => { try { return (JSON.parse(readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'package.json'), 'utf8')) as { version?: string }).version } catch { return undefined } })(),
        lastFetchAt: store.meta.lastFetchAt,
        lastDigestDay: store.meta.lastDigestDay,
        failures,
        cooling: list.filter((s) => s.health.cooldownUntil && new Date(s.health.cooldownUntil).getTime() > Date.now()).length,
      }
    },
  }

  let llmRuntime: ConstructorParameters<typeof DshLlmClient>[0] | undefined
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
  let digestBusy = false // 服务端防重入：调度与手动 /api/digest-run 并发会竞态落盘
  let digestAbort: AbortController | undefined // 「停止生成」：中止在飞的 LLM 调用（流逐条失败→降级收尾，不落半文件）
  const digestNow = (force = false, day?: string) => {
    if (digestBusy) return Promise.resolve({ title: '', date: '', language: 'zh' as const, markdown: '', itemCount: 0, itemIds: [], summarySource: 'extractive' as const, degraded: true, note: 'digest already running' })
    digestBusy = true
    digestAbort = new AbortController()
    digestProg = { running: true, done: 0, total: 0, stage: '' }
    return digestRun(force, day).then((doc) => { addTokens('digest', doc.tokens); return doc })
      .finally(() => { digestBusy = false; digestAbort = undefined; digestProg = { running: false, done: 0, total: 0, stage: '' } })
  }
  const digestRun = (force: boolean, day?: string) => runDailyDigest({
    store,
    day,
    configSources: config.sources,
    // 每次 digest 现组 client：UI 换模型后下次立即生效（resolution 缓存在 client 实例上）
    llmClient: llmRuntime ? new DshLlmClient(llmRuntime, pickRoute(), log) : undefined,
    translateClient: llmRuntime ? new DshLlmClient(llmRuntime, pickTranslateRoute(), log) : undefined,
    llmEnabled: config.llm.enabled,
    summaryEnabled: config.summary.enabled,
    summaryMaxItems: prefs.get().digestOpts?.summaryMaxItems ?? config.summary.maxItems,
    summaryConcurrency: prefs.get().digestOpts?.summaryConcurrency ?? config.summary.concurrency,
    summaryMaxLength: config.summary.maxLength,
    digestItems: prefs.get().digestOpts?.digestItems ?? config.digest.digestItems,
    perTopicLimit: prefs.get().digestOpts?.perTopicLimit ?? config.digest.perTopicLimit,
    llmScoreCandidates: prefs.get().digestOpts?.llmScoreCandidates ?? config.digest.llmScoreCandidates,
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
      prefs.load()
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
        log,
      }))
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
  ctx.inject(['webServer'], (c) => {
    const ws = (c as unknown as { webServer?: unknown }).webServer
    if (ws) {
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
        configLlm: { provider: config.llm.provider, model: config.llm.model },
        configSchedule: {
          digestTimes: config.schedule.digestTimes.length ? config.schedule.digestTimes : [config.dailyTime],
          fetchTimes: config.schedule.fetchTimes,
        },
      }))
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
