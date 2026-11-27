/**
 * 翻译路由 reasoning effort 自动配置。
 *
 * 背景：插件请求 'off' 档推理需要模型在宿主 cordis 里声明 reasoningEfforts
 * 映射（档位 id → wire 值）；未声明的模型 resolveModelInfo 不报档位，
 * 'off' 意图被静默丢弃——推理模型就继续烧 reasoning token。
 *
 * 本模块在 llm 路由确定后自动探测：
 *   1. resolveModelInfo 已报档位 → 用户/宿主已声明，无事可做；
 *   2. 一条小样调用实测模型不吐 reasoning → 非推理模型，无需关断；
 *   3. 确为推理模型且无档位 → 在 cordis.patch.yml 该模型条目按其 API 方言
 *      生成 reasoningEfforts 映射（下次重启/重载 cordis 生效）。
 *
 * 只改用户的 patch 层；识别不了结构（非 pi-ai 路由、cordis.yml 托管等）
 * 一律不动文件，日志告知。
 */
import { existsSync } from 'node:fs'
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

export type EffortProbeResult =
  | { kind: 'has-efforts' }                    // 模型已声明档位——无需动作
  | { kind: 'no-reasoning' }                   // 模型不输出推理——无需关断
  | { kind: 'written'; file: string; api: string } // 已生成配置（重启生效）
  | { kind: 'exists' }                          // patch 文件里已写了——无事可做
  | { kind: 'unsupported'; detail: string }    // 结构不识别——提示人工处理
  | { kind: 'probe-failed'; detail: string }   // 探测调用失败——下次触发再试

/** API 方言 → reasoningEfforts 档位映射（key=pi-ai 档位 id，value=wire 写法）。
 *  注意一律不声明 off：openai-responses 系在 off 有值时会把它当"默认关断"
 *  发给所有不带 effort 的调用——本模型若兼作评分/日报路由会把全局思考关掉。 */
const EFFORT_MAPS: Record<string, string[]> = {
  'openai-responses': ['minimal: "none"', 'low: "low"', 'medium: "medium"', 'high: "high"'],
  'azure-openai-responses': ['minimal: "none"', 'low: "low"', 'medium: "medium"', 'high: "high"'],
  'openai-codex-responses': ['minimal: "none"', 'low: "low"', 'medium: "medium"', 'high: "high"'],
  'openai-completions': ['minimal: "none"', 'low: "low"', 'medium: "medium"', 'high: "high"'],
  // anthropic 方言的"关断"是不带 effort（pi-ai 发 thinking:{type:"disabled"}）——off: null
  'anthropic-messages': ['off: null', 'high: "high"'],
}
/** openai-completions 默认分支还要求 compat.supportsReasoningEffort 才把 effort 发出去 */
const COMPLETIONS_COMPAT = 'supportsReasoningEffort: true'

/** 探测调用：一条小 ping 验证模型是否真吐 reasoning。
 *  刻意绕过全局 LLM 信号量（旁路健康检查，不该排队挡真实调用）；
 *  自带 deadline 竞速——端点挂死/手写生成器不理会 signal 也不会挂住探测。 */
const PROBE_TIMEOUT_MS = 15_000
async function modelEmitsReasoning(llm: LlmRuntime, route: { provider: string; model: string }): Promise<boolean> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [createUserMessage({ content: [{ type: 'text', text: '用一句话回答：23 × 17 等于多少？' }], source: { kind: 'user' } })],
    maxTokens: 2048,
    signal,
  })
  const it = stream[Symbol.asyncIterator]()
  const deadline = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error(`probe stream timed out after ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS)
    t.unref?.() // 旁路探测不撑事件循环——进程退出时不必等它到期
    signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason instanceof Error ? signal.reason : new Error('probe aborted')) }, { once: true })
  })
  try {
    for (;;) {
      const r = await Promise.race([it.next(), deadline])
      if (r.done) return false
      const c = r.value as { type: string; text?: string; reason?: { kind: string; failure?: { message: string } } }
      if (c.type === 'reasoning-delta' && (c.text?.length ?? 0) > 0) return true // 一个 chunk 就够判案
      if (c.type === 'finish') {
        const kind = c.reason?.kind
        if (kind === 'error' || kind === 'aborted') throw new Error(`probe call failed: ${c.reason?.failure?.message ?? kind}`)
        return false
      }
    }
  } finally {
    // 底层流在半死时 return() 可能永不 settle——fire-and-forget（同 idleWatch 的处理）
    try { void it.return?.()?.catch(() => {}) } catch { /* 尽力收尾 */ }
  }
}

/** 定位 cordis.patch.yml 候选（去重、有序）：
 *  1. 本包安装路径向上逐级收集全部命中——npm 布局 profiles/<p>/node_modules/<pkg>/lib/
 *     下，运行中 profile 的 patch 是模块路径祖先，必被命中且排在其他 profile 之前。
 *     注意不能在首个命中处停：包自带的 cordis.patch.yml（bundle patch，无 llm-pi-ai
 *     条目）总是最先命中，早退会让后面的 profile 扫描成为死代码。
 *  2. 扫 DSH_HOME/profiles/* 补 dev(file: 安装 realpath 丢失 profile 祖先）/非常规布局。
 *  调用方逐份尝试 patchCordisText——哪份含目标模型块写哪份，找不到块的不动。 */
export async function cordisFiles(opts: { fromDir?: string; dshHome?: string } = {}): Promise<string[]> {
  const found: string[] = []
  const seen = new Set<string>()
  const push = (p: string): void => { if (!seen.has(p)) { seen.add(p); found.push(p) } }
  let dir = opts.fromDir ?? dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, 'cordis.patch.yml')
    if (existsSync(cand)) push(cand)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const home = opts.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  for (const p of (await readdir(join(home, 'profiles')).catch(() => [] as string[])).sort()) {
    const cand = join(home, 'profiles', p, 'cordis.patch.yml')
    if (existsSync(cand)) push(cand)
  }
  return found
}

const indentOf = (line: string): number => line.length - line.trimStart().length
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface ModelBlock { start: number; end: number; indent: number; api?: string; hasEfforts: boolean; compatIdx?: number; compatEnd?: number }

/** 在 patch 文本里定位 provider>models>model 条目块；找到就返回边界信息。 */
function locateModelBlock(lines: string[], provider: string, model: string): ModelBlock | { reason: string } {
  const entryIdx = lines.findIndex((l) => /^\s*-\s*id:\s*["']?llm-pi-ai["']?\s*$/.test(l))
  if (entryIdx < 0) return { reason: 'patch 里没有 llm-pi-ai 条目（非 pi-ai 路由？）' }
  let entryEnd = lines.length
  for (let i = entryIdx + 1; i < lines.length; i++) {
    if (/^-/.test(lines[i])) { entryEnd = i; break }
  }
  const provsIdx = lines.findIndex((l, i) => i > entryIdx && i < entryEnd && /^\s+providers:\s*$/.test(l))
  if (provsIdx < 0) return { reason: 'llm-pi-ai 条目里没有 providers 块' }
  const provsIndent = indentOf(lines[provsIdx])
  const provRe = new RegExp(`^\\s*["']?${escRe(provider)}["']?:\\s*$`)
  let provIdx = -1
  for (let i = provsIdx + 1; i < entryEnd; i++) {
    const l = lines[i]
    if (!l.trim() || l.trimStart().startsWith('#')) continue
    if (indentOf(l) <= provsIndent) break
    if (provRe.test(l)) { provIdx = i; break }
  }
  if (provIdx < 0) return { reason: `providers 里没有 ${provider} 路由声明` }
  const provIndent = indentOf(lines[provIdx])
  let provEnd = entryEnd
  for (let i = provIdx + 1; i < entryEnd; i++) {
    const l = lines[i]
    if (!l.trim() || l.trimStart().startsWith('#')) continue
    if (indentOf(l) <= provIndent) { provEnd = i; break }
  }
  const api = lines.slice(provIdx, provEnd)
    .map((l) => l.match(/^\s*api:\s*["']?([\w-]+)["']?\s*$/)?.[1])
    .find(Boolean)
  const modelsIdx = lines.findIndex((l, i) => i > provIdx && i < provEnd && /^\s+models:\s*$/.test(l))
  if (modelsIdx < 0) return { reason: `${provider} 路由没有手写 models 列表（catalog 模型改不动）` }
  const modelsIndent = indentOf(lines[modelsIdx])
  const itemRe = new RegExp(`^\\s*-\\s*id:\\s*["']?${escRe(model)}["']?\\s*$`)
  for (let i = modelsIdx + 1; i < provEnd; i++) {
    const l = lines[i]
    if (!l.trim() || l.trimStart().startsWith('#')) continue
    if (indentOf(l) <= modelsIndent) break
    if (!itemRe.test(l)) continue
    // 条目块：[i, 下一个同级 '- ' 或 dedent 之前)
    const indent = indentOf(l)
    let end = provEnd
    for (let j = i + 1; j < provEnd; j++) {
      const lj = lines[j]
      if (!lj.trim() || lj.trimStart().startsWith('#')) continue
      const d = indentOf(lj)
      if (d < indent || (d === indent && /^\s*-/.test(lj))) { end = j; break }
    }
    const hasEfforts = lines.slice(i, end).some((l) => /^\s+reasoningEfforts\s*:/.test(l))
    const compatIdx = lines.findIndex((l, k) => k > i && k < end && new RegExp(`^\\s{${indent + 2}}compat:\\s*$`).test(l))
    let compatEnd: number | undefined
    if (compatIdx >= 0) {
      for (let j = compatIdx + 1; j < end; j++) {
        const lj = lines[j]
        if (!lj.trim() || lj.trimStart().startsWith('#')) continue
        if (indentOf(lj) <= indent + 2) { compatEnd = j; break }
      }
      compatEnd ??= end
    }
    return { start: i, end, indent, api, hasEfforts, compatIdx: compatIdx < 0 ? undefined : compatIdx, compatEnd }
  }
  return { reason: `models 列表里没有 ${model}` }
}

/** 对一份 patch 文本尝试生成并插入 effort 块。导出供测试：纯文本手术，不碰文件系统。 */
export function patchCordisText(text: string, provider: string, model: string): { text?: string; api?: string; exists?: boolean; reason?: string } {
  const lines = text.split('\n')
  const blk = locateModelBlock(lines, provider, model)
  if ('reason' in blk) return { reason: blk.reason }
  if (blk.hasEfforts) return { exists: true, api: blk.api }
  const map = blk.api !== undefined ? EFFORT_MAPS[blk.api] : undefined
  if (!map) return { reason: `未识别的 api 方言 "${blk.api ?? '(未声明)'}"——支持 openai-responses/openai-completions/anthropic-messages` }
  const fieldPad = ' '.repeat(blk.indent + 2)
  const valuePad = ' '.repeat(blk.indent + 4)
  const insert: string[] = []
  // openai-completions 需要 compat.supportsReasoningEffort 才有默认分支的 reasoning_effort 派发
  if (blk.api === 'openai-completions') {
    if (blk.compatIdx !== undefined && blk.compatEnd !== undefined) {
      const hasFlag = lines.slice(blk.compatIdx, blk.compatEnd).some((l) => /supportsReasoningEffort\s*:/.test(l))
      if (!hasFlag) lines.splice(blk.compatEnd, 0, `${valuePad}${COMPLETIONS_COMPAT}`)
    } else {
      insert.push(`${fieldPad}compat:`, `${valuePad}${COMPLETIONS_COMPAT}`)
    }
  }
  insert.push(`${fieldPad}reasoningEfforts:`, ...map.map((m) => `${valuePad}${m}`))
  lines.splice(blk.end, 0, ...insert)
  return { text: lines.join('\n'), api: blk.api }
}

/** 主流程：探测翻译路由，必要时写 cordis.patch.yml。 */
export async function ensureEffortConfig(
  llm: LlmRuntime,
  resolved: { provider: string; model: string },
): Promise<EffortProbeResult> {
  // 能力面探测自带超时：旁路检查挂起不能拖成永久 pending（下一次触发还要靠它终态）
  const info = await llm.resolveModelInfo?.(resolved.provider, resolved.model, AbortSignal.timeout(10_000)).catch(() => undefined)
  if (info?.reasoning?.efforts?.length) return { kind: 'has-efforts' }
  let thinks: boolean
  try {
    thinks = await modelEmitsReasoning(llm, resolved)
  } catch (e) {
    return { kind: 'probe-failed', detail: e instanceof Error ? e.message : String(e) }
  }
  if (!thinks) return { kind: 'no-reasoning' }
  const files = await cordisFiles()
  if (!files.length) return { kind: 'unsupported', detail: '找不到 cordis.patch.yml' }
  let lastReason = ''
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '')
    if (!text) continue
    const r = patchCordisText(text, resolved.provider, resolved.model)
    if (r.exists) return { kind: 'exists' }
    if (r.text !== undefined) {
      // 原子写：cordis.patch.yml 是用户主配置——writeFile 中途崩溃留截断文件
      // 会把全部 provider 配置丢光；tmp+rename 保证要么旧要么新
      const tmp = `${file}.tmp-${process.pid}`
      await writeFile(tmp, r.text)
      try { await rename(tmp, file) }
      catch (e) { await unlink(tmp).catch(() => {}); throw e }
      return { kind: 'written', file, api: r.api ?? '?' }
    }
    lastReason = r.reason ?? ''
  }
  return { kind: 'unsupported', detail: lastReason || '无可用 patch 目标' }
}
