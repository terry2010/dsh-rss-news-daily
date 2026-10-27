/** OPML 2.0 导入/导出（零依赖，复用 parser.ts 的 XmlEl）。 */
import { parseXml } from './parser.js'
import type { XmlEl } from './parser.js'

export interface OpmlEntry {
  title: string
  xmlUrl: string
  htmlUrl?: string
  category?: string
}

function walkOutlines(el: XmlEl, category: string | undefined, out: OpmlEntry[]): void {
  if (el.local === 'outline') {
    const xmlUrl = el.attributes?.xmlUrl || el.attributes?.xmlurl
    if (xmlUrl) {
      out.push({
        title: el.attributes.title || el.attributes.text || xmlUrl,
        xmlUrl,
        htmlUrl: el.attributes.htmlUrl || el.attributes.htmlurl,
        category,
      })
      return // 有 xmlUrl 的节点不再深入（子 outline 视为冗余）
    }
    const nextCat = el.attributes.title || el.attributes.text || category
    for (const c of el.children) if (typeof c !== 'string') walkOutlines(c, nextCat, out)
    return
  }
  for (const c of el.children) if (typeof c !== 'string') walkOutlines(c, category, out)
}

/** 解析 OPML 文本 → 条目列表（按 outline 分组继承分类名）。 */
export function parseOpml(text: string): OpmlEntry[] {
  const doc = parseXml(text)
  if (doc.local !== 'opml') throw new Error('not an OPML document')
  const out: OpmlEntry[] = []
  walkOutlines(doc, undefined, out)
  return out
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 导出条目 → OPML 文本（按 category 分组为一级 outline）。 */
export function generateOpml(entries: Array<{ title: string; url: string; category?: string }>, title = 'dsh-rss-news-daily subscriptions'): string {
  const groups = new Map<string, typeof entries>()
  for (const e of entries) {
    const cat = e.category || 'Uncategorized'
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat)!.push(e)
  }
  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<opml version="2.0"><head><title>${esc(title)}</title></head><body>`,
  ]
  for (const [cat, items] of groups) {
    parts.push(`  <outline text="${esc(cat)}" title="${esc(cat)}">`)
    for (const e of items) {
      parts.push(`    <outline type="rss" text="${esc(e.title)}" title="${esc(e.title)}" xmlUrl="${esc(e.url)}"/>`)
    }
    parts.push(`  </outline>`)
  }
  parts.push(`</body></opml>`)
  return parts.join('\n')
}
