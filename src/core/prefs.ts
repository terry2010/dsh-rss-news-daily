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
  return {
    topics: numMapOf(r.topics),
    keywords: numMapOf(r.keywords),
    bannedKeywords: strListOf(r.bannedKeywords),
    sourceWeight: numMapOf(r.sourceWeight),
    tuningHistory: Array.isArray(r.tuningHistory) ? r.tuningHistory as PrefsFile['tuningHistory'] : [],
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
