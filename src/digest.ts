/**
 * Markdown rendering of a digest document.
 *
 * Pure module: turns digested items + a summary body into a complete Markdown
 * briefing. The summary body is produced by {@link summarize} (LLM or
 * extractive); this module is about the surrounding document.
 */

import type { DigestLanguage, FeedItem } from './core/types.js'

export interface DigestRenderOptions {
  /** Display date of the briefing (e.g. "2026-08-17"). */
  date: string
  language: DigestLanguage
  /** Map of sourceId → source title/label for provenance lines. */
  sourceTitles: ReadonlyMap<string, string>
  items: FeedItem[]
  /** The summary body (computed elsewhere). */
  summaryText: string
  /** Whether the item list embeds permalinks as Markdown links. */
  includeItemLinks: boolean
  /** 采集源状态行（成功/失败/冷却），可选——追加为第三节 */
  sourcesStatus?: string[]
  /** 降级标注（铁律③失败可见）：总结段降级原因，写入正文 */
  degradedNote?: string
}

const LABELS: Record<DigestLanguage, { title: string; sources: string; items: string; generated: string }> = {
  zh: {
    title: 'RSS 简报',
    sources: '订阅源',
    items: '条目',
    generated: '生成于',
  },
  en: {
    title: 'RSS Daily Digest',
    sources: 'sources',
    items: 'items',
    generated: 'generated at',
  },
}

const SECTION_SUMMARY: Record<DigestLanguage, string> = { zh: '今日总结', en: 'Today' }
const SECTION_ITEMS: Record<DigestLanguage, string> = { zh: '重要新闻', en: 'Top Stories' }
const SECTION_SOURCES: Record<DigestLanguage, string> = { zh: '采集源状态', en: 'Source Status' }

/** Escape characters that are syntactically active inside Markdown link text. */
export function escapeLinkText(text: string): string {
  return text.replace(/[\[\]`]/g, (char) => `\\${char}`).replace(/\s+/g, ' ').trim()
}

/**
 * Sanitize a feed-supplied URL for embedding as a Markdown link target.
 * Only http(s) URLs are allowed; control characters are stripped and
 * whitespace/parens/backticks are percent-encoded so a hostile feed cannot
 * break out of the link or inject arbitrary Markdown.
 */
export function safeLinkUrl(link: string): string {
  const trimmed = (link ?? '').trim()
  if (!/^https?:\/\//i.test(trimmed)) return ''
  const cleaned = trimmed.replace(/[\u0000-\u001f\u007f]/g, '')
  return cleaned.replace(/[()\s`]/g, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** How old an item looks: publish date, falling back to fetch date. */
function itemDay(item: FeedItem): string {
  const from = item.publishedAt || item.fetchedAt
  return from.slice(0, 10)
}

/**
 * Render the complete briefing as one Markdown string. Items are expected to
 * be passed newest-first.
 */
export function renderDigest(options: DigestRenderOptions): string {
  const labels = LABELS[options.language]
  const sourceNames = new Set(options.items.map((item) => options.sourceTitles.get(item.sourceId) ?? item.sourceId))
  const header = [
    `# ${labels.title} · ${options.date}`,
    '',
    `> ${options.items.length} ${labels.items} · ${sourceNames.size} ${labels.sources} · `
      + `${labels.generated} ${options.date}`,
    '',
  ].join('\n')

  const summary = [
    `## ${SECTION_SUMMARY[options.language]}`,
    '',
    options.degradedNote ? `> ⚠ 总结段降级：${options.degradedNote}` : '',
    options.summaryText.trim() === '' ? '—' : options.summaryText,
    '',
  ].filter((l) => l !== '').join('\n')

  const lines = options.items.map((item, index) => {
    const source = options.sourceTitles.get(item.sourceId) ?? item.sourceId
    const day = itemDay(item)
    const title = escapeLinkText(item.title)
    const link = options.includeItemLinks ? safeLinkUrl(item.link) : ''
    const head = link !== ''
      ? `${index + 1}. [${title}](${link})`
      : `${index + 1}. ${title}`
    const meta = [source, day, item.dupCount ? `同题 ${item.dupCount + 1} 家报道` : '', item.llmScore != null ? `评分 ${item.llmScore}` : ''].filter((part) => part !== '').join(' · ')
    // 逐条降级回落：aiBlocks 缺失时用 aiSummary/feed 原摘要（截 90 字），保证每条都有摘要行
    const lead = (item.aiSummary || item.summary || '').trim().slice(0, 90)
    const reasons = item.reasons?.length ? ` · _${item.reasons.join('、')}_` : ''
    // 中英对照：有译文的条目加中文标题行 + 译文行
    const tl = (item.state?.translation || '').trim()
    const tnl = tl.indexOf('\n')
    const tlTitle = tnl > 0 ? tl.slice(0, tnl).trim() : ''
    const tlBody = tnl > 0 ? tl.slice(tnl).replace(/\s+/g, ' ').trim() : ''
    // v2 结构化条目块：背景/要点/结论三段；缺块回退一行摘要
    const b = item.aiBlocks
    const bodyMd = b
      ? [['摘要', b.summary], ['背景', b.background], ['影响', b.impact]]
          .filter(([, v]) => (v || '').trim()).map(([k, v]) => `  \n    > ${k}：${escapeLinkText(v)}`).join('')
      : (lead === '' ? '' : `  \n    > ${escapeLinkText(lead)}`)
    return `${head}${tlTitle ? `  \n    ${escapeLinkText(tlTitle)}` : ''}  \n    > ${meta}${reasons}${bodyMd}${tlBody ? `  \n    > 译：${escapeLinkText(tlBody.slice(0, 180))}` : ''}`
  })
  const section = [
    `## ${SECTION_ITEMS[options.language]}`,
    '',
    ...lines,
    '',
  ].join('\n')

  const statusSection = options.sourcesStatus?.length
    ? [`## ${SECTION_SOURCES[options.language]}`, '', ...options.sourcesStatus, ''].join('\n')
    : ''

  const footer = ['---', '', `Generated by dsh-rss-news-daily`, ''].join('\n')
  return `${header}\n${summary}\n${section}\n${statusSection}${footer}`
}

/** Default document header line, useful for file names and CLI output. */
export function digestFileName(date: string, language: DigestLanguage): string {
  const label = language === 'zh' ? 'rss-briefing' : 'rss-digest'
  return `${date}-${label}.md`
}