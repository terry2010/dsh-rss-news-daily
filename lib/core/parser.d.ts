/**
 * Lightweight, dependency-free RSS / Atom / RSS-1.0 parser.
 *
 * Implements just enough of XML to read feeds robustly: comments, CDATA,
 * processing instructions, self-closing tags, quoted attributes, namespaces
 * (matched by local name), and entity decoding. It is intentionally NOT a
 * general XML parser — feeds are small, well-formed documents and this module
 * stays readable and auditable on purpose.
 *
 * Pure module: no I/O, no dsh dependency.
 */
import type { ParsedFeed } from './types.js';
/** Raised when a document cannot be interpreted as a feed document. */
export declare class FeedParseError extends Error {
    constructor(message: string);
}
/** Minimal in-memory XML element tree used internally. */
export interface XmlEl {
    /** Full tag name as written (prefix retained). */
    name: string;
    /** Local (prefix-stripped) tag name. */
    local: string;
    attributes: Record<string, string>;
    children: Array<XmlEl | string>;
}
/** Decode XML character references in a text run. */
export declare function decodeEntities(text: string): string;
/**
 * Parse an XML document into a single root element.
 * @throws {FeedParseError} on structure errors.
 */
export declare function parseXml(xml: string): XmlEl;
/**
 * Parse a feed document (RSS 2.0, RSS 1.0/RDF, or Atom).
 * @param body - the raw feed document text.
 * @throws {FeedParseError} when the document is not a recognizable feed.
 */
export declare function parseFeedDocument(body: string): ParsedFeed;
/** HTML/XML sanitization helper: strip tags and collapse whitespace. */
export declare function stripHtml(html: string): string;
export declare function stripLeadStub(text: string): string;
/** "短正文"判定：汉字数 < zh 且 英文单词数 < en ——两种口径都短才算可疑（默认 15 字 / 10 词） */
export declare function isShortLead(text: string, zh?: number, en?: number): boolean;
/** 无效名单匹配键：去全部空白/标点/符号 + 小写——"点击，查看原文" 与 "点击查看原文" 同键 */
export declare function leadKey(text: string): string;
/** 内容命中无效名单：归一化后精确等值（不做包含匹配——防"广告"类词条误伤正常长文） */
export declare function inBlocklist(text: string, list: readonly string[]): boolean;
/**
 * Truncate text to at most `max` code points without splitting a surrogate
 * pair (`.slice` on UTF-16 indices can leave a dangling half).
 */
export declare function truncateCodePoints(text: string, max: number): string;
//# sourceMappingURL=parser.d.ts.map