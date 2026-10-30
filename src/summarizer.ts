/**
 * Digest summarization: LLM-backed summaries with a deterministic
 * extractive fallback.
 *
 * `summarize()` uses a {@link LlmClient} when one is supplied and enabled;
 * any failure (network, provider, LLM error, empty answer) degrades to an
 * extractive summary built from the same items — the "model call failed,
 * degrade to raw-text summary" contract. Summaries are always bounded to
 * `maxLength` characters as a hard cap.
 *
 * Pure module: no dsh dependency.
 */

import { stripHtml, truncateCodePoints } from './core/parser.js'
import type { DigestLanguage, SummaryMode } from './core/types.js'

/** A display-ready item view sent to the summarizer. */
export interface SummarizableItem {
  title: string
  link: string
  summary: string
  content: string
  sourceTitle: string
  publishedAt: string
  /** 分类/领域（领域分块总结用）；缺省按"综合" */
  topic?: string
  /** 抓取时刻 HH:mm（时间线式总结用） */
  hour?: string
}

export interface SummarizeRequest {
  items: SummarizableItem[]
  language: DigestLanguage
  mode: SummaryMode
  maxLength: number
  /** 附加指令（热点提示/时间线组织等），拼到 prompt 尾部 */
  notes?: string
  /** Token budget hint for the model call. */
  maxTokens?: number
  /** Abort signal forwarded to the model call when supported. */
  signal?: AbortSignal
}

export interface SummarizeResult {
  text: string
  source: 'llm' | 'extractive'
  error?: string
}

/** The single seam through which this package talks to a text model. */
export interface LlmClient {
  generateText(request: LlmTextRequest): Promise<string>
}

export interface LlmTextRequest {
  system?: string
  prompt: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

const LANGUAGE_LABEL: Record<DigestLanguage, string> = {
  zh: '简体中文',
  en: 'English',
}

const SYSTEM_PROMPT: Record<DigestLanguage, string> = {
  zh: '你是一名资深新闻编辑。根据给定的新闻条目，整理成简洁、准确、有序的简报摘要。'
    + '直接输出 Markdown 纯文本；不要寒暄，不要编造原文中没有的信息，不要重复条目标题列表。',
  en: 'You are a senior news editor. From the given news items, produce a concise, '
    + 'accurate and well-ordered digest. Output plain Markdown text only; no pleasantries, '
    + 'no facts absent from the input, do not repeat the item title list.',
}

/** Clean up a slice of item text for embedding in a prompt. */
function itemLead(item: SummarizableItem, chars: number): string {
  const raw = item.summary || item.content || ''
  const plain = truncateCodePoints(stripHtml(raw), chars)
  return plain === '' ? item.title : plain
}

/** Number of characters allowed per item when serializing a request. */
const PER_ITEM_CHARS = 220

/** Render the prompt body for a request. */
export function buildPrompt(request: SummarizeRequest): { system: string; prompt: string } {
  const language = LANGUAGE_LABEL[request.language]
  const count = request.items.length
  const maxLength = request.maxLength
  const lines = request.items.map((item, index) => {
    const date = item.publishedAt === '' ? '' : ` | ${item.publishedAt.slice(0, 10)}`
    const source = item.sourceTitle === '' ? '' : `（${item.sourceTitle}）`
    return `${index + 1}. 「${item.title}」${source}${date}\n   内容：${itemLead(item, PER_ITEM_CHARS)}`
  }).join('\n')
  if (request.mode === 'single') {
    return {
      system: SYSTEM_PROMPT[request.language],
      prompt: `请用${language}逐条总结下面 ${count} 条新闻，每条给出 1-2 句话的要点，`
        + `用与输入相同编号的 Markdown 列表输出，全文不超过 ${maxLength} 字：\n\n${lines}`,
    }
  }
  return {
    system: SYSTEM_PROMPT[request.language],
    prompt: `请用${language}为下面 ${count} 条新闻生成一份通顺的整体摘要`
      + `（概述、重点、趋势），全文不超过 ${maxLength} 字，使用 Markdown：\n\n${lines}`
      + (request.notes ? `\n\n写作要求：${request.notes}` : ''),
  }
}

/**
 * Extractive fallback summary: titled bullet lines with the first meaningful
 * sentence of every item, bounded by `maxLength`.
 */
export function extractiveSummary(
  items: SummarizableItem[],
  language: DigestLanguage,
  maxLength: number,
): string {
  if (items.length === 0) {
    return language === 'zh' ? '（没有可汇总的条目）' : '(no items to summarize)'
  }
  const lead = (item: SummarizableItem): string => {
    const text = stripHtml(item.summary || item.content || '').trim()
    if (text === '') return ''
    const truncated = text.length > 90
    const slice = (truncated ? truncateCodePoints(text, 90) : text).trimEnd()
    if (/[.!?。…]$/.test(slice)) return slice
    return truncated ? `${slice}…` : `${slice}${language === 'zh' ? '。' : '.'}`
  }
  const lines = items.map((item, index) => {
    const body = lead(item)
    const link = item.link === '' ? '' : ` ${item.link}`
    return `${index + 1}. ${item.title}${body === '' ? '' : ` — ${body}`}${link}`
  })
  return truncateText(lines.join('\n'), maxLength)
}

/** Bound a string to `chars` characters (code points) at a safe boundary. */
export function truncateText(text: string, chars: number): string {
  if (text.length <= chars) return text
  const cut = truncateCodePoints(text, chars - 1)
  return `${cut}…`
}

/**
 * Summarize items. Uses the model when enabled; any model failure degrades to
 * the extractive summary. Never throws.
 */
export async function summarize(
  request: SummarizeRequest,
  client: LlmClient | undefined,
  llmEnabled: boolean,
): Promise<SummarizeResult> {
  const fallback = (error?: string): SummarizeResult => ({
    text: extractiveSummary(request.items, request.language, request.maxLength),
    source: 'extractive',
    error,
  })
  if (!llmEnabled || client === undefined || request.items.length === 0) {
    return fallback()
  }
  const { system, prompt } = buildPrompt(request)
  let text: string
  try {
    text = await client.generateText({
      system,
      prompt,
      maxTokens: request.maxTokens ?? Math.min(2048, 256 + Math.ceil(request.maxLength / 2)),
      temperature: 0.3,
      signal: request.signal,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return fallback(reason)
  }
  const trimmed = truncateText(text.trim(), request.maxLength)
  if (trimmed === '') {
    return fallback('empty model output')
  }
  return { text: trimmed, source: 'llm' }
}