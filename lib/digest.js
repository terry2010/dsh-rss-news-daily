/**
 * Markdown rendering of a digest document.
 *
 * Pure module: turns digested items + a summary body into a complete Markdown
 * briefing. The summary body is produced by {@link summarize} (LLM or
 * extractive); this module is about the surrounding document.
 */
import { stripLeadStub } from './core/parser.js';
const LABELS = {
    zh: {
        title: '每日精选',
        sources: '订阅源',
        items: '条目',
        generated: '生成于',
    },
    en: {
        title: 'Daily Digest',
        sources: 'sources',
        items: 'items',
        generated: 'generated at',
    },
};
const SECTION_SUMMARY = { zh: '概述', en: 'Overview' };
const SECTION_ITEMS = { zh: '重要新闻', en: 'Top Stories' };
const SECTION_SOURCES = { zh: '采集源状态', en: 'Source Status' };
/** Escape characters that are syntactically active inside Markdown link text. */
export function escapeLinkText(text) {
    return text.replace(/[\[\]`]/g, (char) => `\\${char}`).replace(/\s+/g, ' ').trim();
}
/**
 * Sanitize a feed-supplied URL for embedding as a Markdown link target.
 * Only http(s) URLs are allowed; control characters are stripped and
 * whitespace/parens/backticks are percent-encoded so a hostile feed cannot
 * break out of the link or inject arbitrary Markdown.
 */
export function safeLinkUrl(link) {
    const trimmed = (link ?? '').trim();
    if (!/^https?:\/\//i.test(trimmed))
        return '';
    const cleaned = trimmed.replace(/[\u0000-\u001f\u007f]/g, '');
    return cleaned.replace(/[()\s`]/g, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
/** How old an item looks: publish date, falling back to fetch date. */
function itemDay(item) {
    const from = item.publishedAt || item.fetchedAt;
    return from.slice(0, 10);
}
/**
 * Render the complete briefing as one Markdown string. Items are expected to
 * be passed newest-first.
 */
export function renderDigest(options) {
    const labels = LABELS[options.language];
    const sourceNames = new Set(options.items.map((item) => options.sourceTitles.get(item.sourceId) ?? item.sourceId));
    const dur = options.durationMs != null ? ` · 耗时 ${Math.round(options.durationMs / 1000)}s` : '';
    const genTime = options.generatedAt
        ? `${options.date} ${String(options.generatedAt.getHours()).padStart(2, '0')}:${String(options.generatedAt.getMinutes()).padStart(2, '0')}`
        : options.date;
    const header = [
        `# ${labels.title} · ${options.date}`,
        '',
        `> ${options.items.length} ${labels.items} · ${sourceNames.size} ${labels.sources} · `
            + `${labels.generated} ${genTime}${dur}`,
        '',
    ].join('\n');
    // LLM 总结里夹带的裸标题：与本节同名的（概述/Overview）直接丢弃，其余降为加粗行
    const summaryText = options.summaryText.replace(/^#{1,6}\s+(.+)$/gm, (_m, t) => t.trim() === SECTION_SUMMARY[options.language] ? '' : `**${t.trim()}**`);
    const summary = [
        `## ${SECTION_SUMMARY[options.language]}`,
        '',
        options.degradedNote ? `> ⚠ 总结段降级：${options.degradedNote}` : '',
        summaryText.trim() === '' ? '—' : summaryText.split('\n').map((l) => `> ${l}`).join('\n'), // 概述整段进白色引用卡（mdLite 连续 > 行已合并）
        '',
    ].filter((l) => l !== '').join('\n');
    // 领域目录：可点击锚点跳到对应领域摘要（id=领域名，mdLite 给标题生成同名锚点）
    const domainSec = options.domainSummaries?.length
        ? ['## 领域目录', '', ...options.domainSummaries.map((d) => `- **[${d.topic}](#${d.topic})** · ${d.count}条 — ${d.text.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 80)}`), ''].join('\n')
        : '';
    const itemLine = (item, index) => {
        const source = options.sourceTitles.get(item.sourceId) ?? item.sourceId;
        const day = itemDay(item);
        const tlRaw = (item.state?.translation || '').trim();
        const tnl0 = tlRaw.indexOf('\n');
        const zhTitle = item.aiTitle || (tlRaw ? (tnl0 > 0 ? tlRaw.slice(0, tnl0) : tlRaw).trim() : '') || item.title;
        const title = escapeLinkText(zhTitle);
        const link = options.includeItemLinks ? safeLinkUrl(item.link) : '';
        const tip = zhTitle.trim() !== item.title.trim() ? ` "${item.title.replace(/"/g, "'").replace(/\s+/g, ' ').trim()}"` : '';
        const head = link !== ''
            ? `${index + 1}. [${title}](${link}${tip})`
            : `${index + 1}. ${title}`;
        const meta = [source, day, item.dupCount ? `同题 ${item.dupCount + 1} 家报道` : '', item.llmScore != null ? `评分 ${item.llmScore}` : '', (item.hotCycles ?? 0) >= 2 ? `🔥${item.hotCycles}时段` : '', ...(item.tags || []).map((t) => `#${t}`)].filter((part) => part !== '').join(' · ');
        // 逐条降级回落：aiBlocks 缺失时用 aiSummary/feed 原摘要（截 90 字），保证每条都有摘要行
        const lead = stripLeadStub(item.aiSummary || item.summary || '').slice(0, 90);
        const reasons = item.reasons?.length ? ` · _${item.reasons.join('、')}_` : '';
        // 中英对照：有译文的条目加中文标题行 + 译文行
        const tlTitle = tnl0 > 0 ? tlRaw.slice(0, tnl0).trim() : '';
        const tlBody = tnl0 > 0 ? tlRaw.slice(tnl0).replace(/\s+/g, ' ').trim() : '';
        // v2 结构化条目块：背景/要点/结论三段；缺块回退一行摘要
        const b = item.aiBlocks;
        const bodyMd = b
            ? [['摘要', b.summary], ['背景', b.background], ['影响', b.impact]]
                .filter(([, v]) => (v || '').trim()).map(([k, v]) => `  \n    > ${k}：${escapeLinkText(v)}`).join('')
            : (lead === '' ? '' : `  \n    > ${escapeLinkText(lead)}`);
        return `${head}${tlTitle ? `  \n    ${escapeLinkText(tlTitle)}` : ''}  \n    > ${meta}${reasons}${bodyMd}${tlBody ? `  \n    > 译：${escapeLinkText(tlBody.slice(0, 180))}` : ''}`;
    };
    // P6：条目按领域分块——组序=组内首条在 ranked 序中的出现序（顶部即最强领域）；编号全局连续
    const byTopic = new Map();
    options.items.forEach((item, index) => {
        const t = item.topic || '综合';
        byTopic.set(t, [...(byTopic.get(t) ?? []), { item, index }]);
    });
    const summaryByTopic = new Map((options.domainSummaries ?? []).map((d) => [d.topic, d]));
    const sectionParts = [`## ${SECTION_ITEMS[options.language]}`, ''];
    for (const [topic, list] of byTopic) {
        sectionParts.push(`### ${topic}`, '');
        const dom = summaryByTopic.get(topic);
        if (dom)
            sectionParts.push(`> ${dom.text.replace(/\s+/g, ' ').trim().slice(0, 200)}`, '');
        sectionParts.push(...list.map(({ item, index }) => itemLine(item, index)), '');
    }
    const section = sectionParts.join('\n');
    const statusSection = options.sourcesStatus?.length
        ? [`## ${SECTION_SOURCES[options.language]}`, '', ...options.sourcesStatus, ''].join('\n')
        : '';
    const footer = ['---', '', `Generated by dsh-rss-news-daily`, ''].join('\n');
    return `${header}\n${summary}\n${domainSec ? `${domainSec}\n` : ''}${section}\n${statusSection}${footer}`;
}
/** Default document header line, useful for file names and CLI output. */
export function digestFileName(date, language) {
    const label = language === 'zh' ? 'rss-briefing' : 'rss-digest';
    return `${date}-${label}.md`;
}
//# sourceMappingURL=digest.js.map