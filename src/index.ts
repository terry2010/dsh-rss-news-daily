/**
 * dsh-rss-news-daily bundle 入口。
 *
 * 契约（loader 消费）：name / inject / Config / apply。
 * host 半体：抓取调度（timer）、news_* 工具（tools）、阅读器路由（webServer）。
 * llm 为可选能力：缺失时总结/摘要走抽取式降级，插件仍可加载（铁律 2）。
 */

import '@deepseek-ai/cordis-plugin-timer'

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

import { Config } from './config.js'
import type { Config as ConfigType } from './config.js'

export { Config }

export const name = 'rss-news-daily'

/** 静态依赖：定时调度、模型工具、阅读器路由——缺了任何一项核心功能不成立 */
export const inject = ['timer', 'tools', 'webServer']

interface BuiltinSourcesFile {
  schema: number
  sources: Array<{ name: string; url: string; defaultEnabled?: boolean }>
}

function loadBuiltinSources(): BuiltinSourcesFile['sources'] {
  // lib/sources.builtin.json 由 scripts/copy-assets.mjs 从 src/ 拷入
  const file = join(fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, ''), 'sources.builtin.json')
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as BuiltinSourcesFile
  return parsed.sources
}

function resolveDataDir(configured: string): string {
  if (configured) return configured
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'data', 'rss-news-daily')
  return join(homedir(), '.dsh', 'rss-news-daily')
}

export function apply(ctx: Context, config: ConfigType): void {
  const log = ctx.logger('rss-news-daily')

  if (!config.enabled) {
    log.info('disabled by config; loaded inert')
    return
  }

  const dataDir = resolveDataDir(config.dataDir)
  const builtin = loadBuiltinSources()
  const enabledCount = builtin.filter((s) => s.defaultEnabled !== false).length

  log.info(
    `loaded: dataDir=${dataDir} builtin=${builtin.length} sources `
    + `(${enabledCount} enabled) digestItems=${config.digest.digestItems} `
    + `dailyTime=${config.dailyTime} tz=${config.timezone || 'host-local'}`,
  )

  // 可选能力按服务逐项声明：有就用、没有就降级，绝不因缺服务而拒载。
  ctx.inject(['llm'], () => {
    log.info('llm service available: LLM summaries enabled')
  })
}
