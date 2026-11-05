/**
 * Markdown rendering of a digest document.
 *
 * Pure module: turns digested items + a summary body into a complete Markdown
 * briefing. The summary body is produced by {@link summarize} (LLM or
 * extractive); this module is about the surrounding document.
 */
import type { DigestLanguage, FeedItem } from './core/types.js';
export interface DigestRenderOptions {
    /** Display date of the briefing (e.g. "2026-08-17"). */
    date: string;
    language: DigestLanguage;
    /** Map of sourceId → source title/label for provenance lines. */
    sourceTitles: ReadonlyMap<string, string>;
    items: FeedItem[];
    /** The summary body (computed elsewhere). */
    summaryText: string;
    /** Whether the item list embeds permalinks as Markdown links. */
    includeItemLinks: boolean;
    /** 采集源状态行（成功/失败/冷却），可选——追加为第三节 */
    sourcesStatus?: string[];
    /** 降级标注（铁律③失败可见）：总结段降级原因，写入正文 */
    degradedNote?: string;
    /** 生成耗时（毫秒），渲染进头部 meta 行 */
    durationMs?: number;
    /** 生成时刻（渲染详细时间，缺省只显示 date） */
    generatedAt?: Date;
    /** 领域速览：每领域一行摘要+条数（今日重点之后渲染） */
    domainSummaries?: Array<{
        topic: string;
        text: string;
        count: number;
    }>;
}
/** Escape characters that are syntactically active inside Markdown link text. */
export declare function escapeLinkText(text: string): string;
/**
 * Sanitize a feed-supplied URL for embedding as a Markdown link target.
 * Only http(s) URLs are allowed; control characters are stripped and
 * whitespace/parens/backticks are percent-encoded so a hostile feed cannot
 * break out of the link or inject arbitrary Markdown.
 */
export declare function safeLinkUrl(link: string): string;
/**
 * Render the complete briefing as one Markdown string. Items are expected to
 * be passed newest-first.
 */
export declare function renderDigest(options: DigestRenderOptions): string;
/** Default document header line, useful for file names and CLI output. */
export declare function digestFileName(date: string, language: DigestLanguage): string;
//# sourceMappingURL=digest.d.ts.map