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
/**
 * Truncate text to at most `max` code points without splitting a surrogate
 * pair (`.slice` on UTF-16 indices can leave a dangling half).
 */
export declare function truncateCodePoints(text: string, max: number): string;
//# sourceMappingURL=parser.d.ts.map