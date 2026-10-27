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
import { createFetcher } from './core/fetcher.js'
import { effectiveSources, runFetchCycle, addSource, removeSource, setSourceEnabled, normalizeUrl } from './service.js'
import { startScheduler } from './scheduler.js'
import { registerTools } from './tools.js'
import type { NewsService } from './tools.js'

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

  const runFetch = () => runFetchCycle({
    fetch: fetcher,
    store,
    sources: effectiveSources(config.sources, store), // 每轮重取：用户改源/健康度实时生效
    maxItemsPerSource: config.fetch.maxItemsPerSource,
    storeContentChars: config.fetch.storeContentChars,
    concurrency: config.fetch.concurrency,
    dedupeThreshold: config.dedupe.threshold,
    dedupeWindowDays: config.dedupe.windowDays,
    log,
  })

  // 对外操作门面：tools（M2）与 HTTP API（M4）共用同一组语义
  const svc: NewsService = {
    listSources: () => effectiveSources(config.sources, store),
    addSource: (o) => addSource(fetcher, store, o),
    setEnabled: (id, en) => setSourceEnabled(store, id, en),
    removeSource: (id) => removeSource(store, id),
    runFetch,
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

  let disposed = false
  void store.load()
    .then(() => {
      if (disposed) return
      registerTools(ctx, svc)
      startScheduler(ctx as unknown as TimerSeam, {
        fetch: config.fetch,
        dailyTime: config.dailyTime,
        timezone: config.timezone,
        catchUpHours: config.catchUpHours,
        enabled: true,
        lastDigestDay: () => store.meta.lastDigestDay,
        runFetchCycle: runFetch,
        runDailyDigest: async () => { log.info('daily digest: M3 pipeline not wired yet') },
        log,
      })
      log.info('tools registered, scheduler armed')
    })
    .catch((e) => log.error('store load failed; plugin degraded to inert', e))

  // 可选能力按服务逐项声明：有就用、没有就降级，绝不因缺服务而拒载。
  ctx.inject(['llm'], () => {
    log.info('llm service available: LLM summaries enabled')
  })
  ctx.inject(['webServer'], () => {
    log.info('webServer available: reader page will mount at /dsh-rss-news-daily/')
  })
}
