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
import { stripHtml, truncateCodePoints } from './core/parser.js';
const LANGUAGE_LABEL = {
    zh: '简体中文',
    en: 'English',
};
const SYSTEM_PROMPT = {
    zh: '你是一名资深新闻编辑。根据给定的新闻条目，整理成简洁、准确、有序的简报摘要。'
        + '直接输出 Markdown 纯文本；不要寒暄，不要编造原文中没有的信息，不要重复条目标题列表。',
    en: 'You are a senior news editor. From the given news items, produce a concise, '
        + 'accurate and well-ordered digest. Output plain Markdown text only; no pleasantries, '
        + 'no facts absent from the input, do not repeat the item title list.',
};
/** Clean up a slice of item text for embedding in a prompt. */
function itemLead(item, chars) {
    const raw = item.summary || item.content || '';
    const plain = truncateCodePoints(stripHtml(raw), chars);
    return plain === '' ? item.title : plain;
}
/** Number of characters allowed per item when serializing a request. */
const PER_ITEM_CHARS = 220;
/** Render the prompt body for a request. */
export function buildPrompt(request) {
    const language = LANGUAGE_LABEL[request.language];
    const count = request.items.length;
    const maxLength = request.maxLength;
    const lines = request.items.map((item, index) => {
        const date = item.publishedAt === '' ? '' : ` | ${item.publishedAt.slice(0, 10)}`;
        const source = item.sourceTitle === '' ? '' : `（${item.sourceTitle}）`;
        return `${index + 1}. 「${item.title}」${source}${date}\n   内容：${itemLead(item, PER_ITEM_CHARS)}`;
    }).join('\n');
    if (request.mode === 'single') {
        return {
            system: SYSTEM_PROMPT[request.language],
            prompt: `请用${language}逐条总结下面 ${count} 条新闻，每条给出 1-2 句话的要点，`
                + `用与输入相同编号的 Markdown 列表输出，全文不超过 ${maxLength} 字：\n\n${lines}`,
        };
    }
    return {
        system: SYSTEM_PROMPT[request.language],
        prompt: `请用${language}为下面 ${count} 条新闻生成一份通顺的整体摘要`
            + `（概述、重点、趋势），全文不超过 ${maxLength} 字，使用 Markdown：\n\n${lines}`
            + (request.notes ? `\n\n写作要求：${request.notes}` : ''),
    };
}
/**
 * Extractive fallback summary: titled bullet lines with the first meaningful
 * sentence of every item, bounded by `maxLength`.
 */
export function extractiveSummary(items, language, maxLength) {
    if (items.length === 0) {
        return language === 'zh' ? '（没有可汇总的条目）' : '(no items to summarize)';
    }
    const lead = (item) => {
        const text = stripHtml(item.summary || item.content || '').trim();
        if (text === '')
            return '';
        const truncated = text.length > 90;
        const slice = (truncated ? truncateCodePoints(text, 90) : text).trimEnd();
        if (/[.!?。…]$/.test(slice))
            return slice;
        return truncated ? `${slice}…` : `${slice}${language === 'zh' ? '。' : '.'}`;
    };
    const lines = items.map((item, index) => {
        const body = lead(item);
        const link = item.link === '' ? '' : ` ${item.link}`;
        return `${index + 1}. ${item.title}${body === '' ? '' : ` — ${body}`}${link}`;
    });
    return truncateText(lines.join('\n'), maxLength);
}
/** Bound a string to `chars` characters (code points) at a safe boundary. */
export function truncateText(text, chars) {
    if (text.length <= chars)
        return text;
    const cut = truncateCodePoints(text, chars - 1);
    return `${cut}…`;
}
/**
 * Summarize items. Uses the model when enabled; any model failure degrades to
 * the extractive summary. Never throws.
 */
export async function summarize(request, client, llmEnabled) {
    const fallback = (error) => ({
        text: extractiveSummary(request.items, request.language, request.maxLength),
        source: 'extractive',
        error,
    });
    if (!llmEnabled || client === undefined || request.items.length === 0) {
        return fallback();
    }
    const { system, prompt } = buildPrompt(request);
    // 推理模型偶发空回复（reasoning 吃光预算/本地服务抖动）：重试一次且预算翻倍，仍败才降级
    const budget = request.maxTokens ?? Math.min(2048, 256 + Math.ceil(request.maxLength / 2));
    let text = '';
    let lastErr;
    for (let attempt = 0; attempt < 2 && text === ''; attempt++) {
        try {
            text = (await client.generateText({
                system,
                prompt,
                maxTokens: attempt === 0 ? budget : Math.min(budget * 2, 32768),
                temperature: 0.3,
                signal: request.signal,
                purpose: 'digest-prose',
            })).trim();
            if (text === '')
                lastErr = 'empty model output';
        }
        catch (error) {
            lastErr = error instanceof Error ? error.message : String(error);
        }
    }
    if (text === '')
        return fallback(lastErr);
    return { text: truncateText(text, request.maxLength), source: 'llm' };
}
//# sourceMappingURL=summarizer.js.map