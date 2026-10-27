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
import { effectiveSources, runFetchCycle, addSource, removeSource, setSourceEnabled, setSourceSummarize, importOpml, exportOpml } from './service.js'
import { startScheduler } from './scheduler.js'
import { registerTools } from './tools.js'
import type { NewsService } from './tools.js'
import { runDailyDigest } from './digest-pipeline.js'
import { DshLlmClient } from './dsh-llm.js'
import type { LlmClient } from './summarizer.js'
import { mountApi } from './api.js'
import { parseTune } from './core/tune.js'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { digestFileName } from './digest.js'
import { normalizeUrl } from './service.js'
import { learnFromFeedback } from './core/tune.js'
import { zonedDayKey } from './core/time.js'

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
  const store = new Store({ path: join(dataDir, 'store.json'), maxItems: config.fetch.maxStoredItems, log })
  const prefs = new PrefsStore(join(dataDir, 'prefs.json'), log)
  const fetcher = createFetcher({
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
    sources: sources ?? effectiveSources(config.sources, store), // 每轮重取：用户改源/健康度实时生效
    maxItemsPerSource: config.fetch.maxItemsPerSource,
    storeContentChars: config.fetch.storeContentChars,
    concurrency: config.fetch.concurrency,
    dedupeThreshold: config.dedupe.threshold,
    dedupeWindowDays: config.dedupe.windowDays,
    log,
  })
  const runFetch = () => runFetchCycle(makeFetchOpts())
  const runFetchFor = (sources: ReturnType<typeof effectiveSources>) => runFetchCycle(makeFetchOpts(sources))

  // 对外操作门面：tools（M2）与 HTTP API（M4）共用同一组语义
  const svc: NewsService = {
    listSources: () => effectiveSources(config.sources, store),
    addSource: (o) => addSource(fetcher, store, o),
    setEnabled: (id, en) => setSourceEnabled(store, id, en),
    setSummarize: (id, s) => {
      const cur = effectiveSources(config.sources, store).find((x) => x.id === normalizeUrl(id) || x.url === id)
      return setSourceSummarize(store, id, s, cur?.enabled ?? true)
    },
    removeSource: (id) => removeSource(store, id),
    importOpml: (text) => importOpml(store, text, config.sources),
    exportOpml: () => exportOpml(store, config.sources),
    runFetch,
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
      await store.save()
      // 清完锁立刻单抓这个源：成功 health.ok 立涨，用户不用等下一轮 interval
      await runFetchFor([src]).catch((e) => log.warn(`retry fetch failed for ${src.id}: ${String(e)}`))
      return true
    },
    status: () => {
      const list = effectiveSources(config.sources, store)
      const failures = list.filter((s) => s.health.lastError).map((s) => ({ name: s.title, error: s.health.lastError! }))
      return {
        sources: list.length,
        enabled: list.filter((s) => s.enabled).length,
        items: store.items.length,
        lastFetchAt: store.meta.lastFetchAt,
        lastDigestDay: store.meta.lastDigestDay,
        failures,
      }
    },
  }

  let llmRuntime: ConstructorParameters<typeof DshLlmClient>[0] | undefined
  const pickRoute = (): { provider: string; model: string } => {
    const ui = prefs.get().llm
    if (ui?.provider && ui?.model) return ui // UI 覆盖 > config 对 > 自动
    return { provider: config.llm.provider, model: config.llm.model }
  }
  const digestNow = (force = false) => runDailyDigest({
    store,
    configSources: config.sources,
    // 每次 digest 现组 client：UI 换模型后下次立即生效（resolution 缓存在 client 实例上）
    llmClient: llmRuntime ? new DshLlmClient(llmRuntime, pickRoute(), log) : undefined,
    llmEnabled: config.llm.enabled,
    summaryEnabled: config.summary.enabled,
    summaryMaxItems: config.summary.maxItems,
    summaryConcurrency: config.summary.concurrency,
    summaryMaxLength: config.summary.maxLength,
    digestItems: config.digest.digestItems,
    perTopicLimit: config.digest.perTopicLimit,
    digestMaxLength: config.digest.maxLength,
    llmTimeoutMs: config.llm.timeoutMs,
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
        fetch: config.fetch,
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
