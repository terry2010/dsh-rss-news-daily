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
/** Raised when a document cannot be interpreted as a feed document. */
export class FeedParseError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FeedParseError';
    }
}
const NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
};
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;
/** Decode XML character references in a text run. */
export function decodeEntities(text) {
    return text.replace(ENTITY_RE, (full, body) => {
        if (body[0] === '#') {
            const hex = body[1] === 'x' || body[1] === 'X';
            const raw = body.slice(hex ? 2 : 1);
            const code = parseInt(raw, hex ? 16 : 10);
            if (Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) {
                return String.fromCodePoint(code);
            }
            return full;
        }
        return NAMED_ENTITIES[body] ?? full;
    });
}
const MAX_DEPTH = 200;
/**
 * Parse an XML document into a single root element.
 * @throws {FeedParseError} on structure errors.
 */
export function parseXml(xml) {
    const stack = [];
    let root;
    let i = 0;
    while (i < xml.length) {
        const lt = xml.indexOf('<', i);
        if (lt === -1) {
            break;
        }
        // Interstitial plain text belongs to the current open element.
        if (lt > i && stack.length > 0) {
            const text = xml.slice(i, lt);
            if (text.trim().length > 0)
                stack[stack.length - 1].children.push(text);
        }
        if (xml.startsWith('<!--', lt)) {
            const end = xml.indexOf('-->', lt);
            if (end === -1)
                break;
            i = end + 3;
            continue;
        }
        if (xml.startsWith('<![CDATA[', lt)) {
            const end = xml.indexOf(']]>', lt);
            if (end === -1)
                break;
            const text = xml.slice(lt + 9, end);
            if (stack.length > 0 && text.trim().length > 0) {
                stack[stack.length - 1].children.push(text);
            }
            i = end + 3;
            continue;
        }
        if (xml.startsWith('<?', lt)) {
            const end = xml.indexOf('?>', lt);
            i = end === -1 ? xml.length : end + 2;
            continue;
        }
        if (xml.startsWith('<!', lt)) {
            // DOCTYPE and other declarations.
            const end = xml.indexOf('>', lt);
            if (end === -1)
                break;
            i = end + 1;
            continue;
        }
        if (xml[lt + 1] === '/') {
            const end = xml.indexOf('>', lt);
            const name = xml.slice(lt + 2, end === -1 ? xml.length : end).trim();
            const top = stack.pop();
            if (top === undefined)
                break;
            // Elements are already attached to their parent when opened; the
            // close tag only pops the stack. A mismatched close (tolerated) just
            // discards the dangling element and its content.
            i = end === -1 ? xml.length : end + 1;
            continue;
        }
        // Opening tag.
        let quote = null;
        let j = lt + 1;
        while (j < xml.length) {
            const c = xml[j];
            if (quote !== null) {
                if (c === quote)
                    quote = null;
            }
            else if (c === '"' || c === "'") {
                quote = c;
            }
            else if (c === '>') {
                break;
            }
            j += 1;
        }
        if (j >= xml.length)
            break;
        const rawContent = xml.slice(lt + 1, j);
        const selfClosing = rawContent.endsWith('/');
        const inner = selfClosing ? rawContent.slice(0, -1).trimEnd() : rawContent.trim();
        const parsed = parseTag(inner);
        const element = { name: parsed.name, local: localName(parsed.name), attributes: parsed.attributes, children: [] };
        if (stack.length > 0) {
            stack[stack.length - 1].children.push(element);
        }
        else if (root === undefined) {
            root = element;
        }
        if (!selfClosing) {
            if (stack.length >= MAX_DEPTH) {
                throw new FeedParseError(`XML nesting exceeds ${MAX_DEPTH} levels`);
            }
            stack.push(element);
        }
        i = j + 1;
    }
    if (root === undefined) {
        throw new FeedParseError('document contains no root element');
    }
    return root;
}
/** Split a tag body ("name attr=val ...") into name + attribute map. */
function parseTag(inner) {
    const nameMatch = /^([^\s/>]+)/.exec(inner);
    if (nameMatch === null)
        throw new FeedParseError('malformed tag');
    const name = nameMatch[1];
    const attributes = {};
    // eslint-disable-next-line regexp/no-super-linear-backtracking
    const attrRe = /\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let match;
    while ((match = attrRe.exec(inner)) !== null) {
        const key = match[1];
        const value = match[2] ?? match[3] ?? match[4] ?? '';
        attributes[localName(key)] = decodeEntities(value);
    }
    return { name, attributes };
}
function localName(name) {
    const colon = name.indexOf(':');
    return colon === -1 ? name : name.slice(colon + 1);
}
/** Concatenated descendant text of an element (entities decoded). */
function textOf(el) {
    let out = '';
    const walk = (node) => {
        if (typeof node === 'string') {
            out += node;
        }
        else {
            for (const child of node.children)
                walk(child);
        }
    };
    for (const child of el.children)
        walk(child);
    return decodeEntities(out);
}
/** First descendant element by local name (direct children only). */
function child(el, local) {
    for (const node of el.children) {
        if (typeof node !== 'string' && node.local === local)
            return node;
    }
    return undefined;
}
/** All direct child elements with the given local name. */
function children(el, local) {
    const out = [];
    for (const node of el.children) {
        if (typeof node !== 'string' && node.local === local)
            out.push(node);
    }
    return out;
}
/** Text of the first direct child element with `local` name, or '' . */
function childText(el, local) {
    const found = child(el, local);
    return found === undefined ? '' : textOf(found).trim();
}
/** Normalize a raw date string to ISO-8601, or '' when unparseable. */
function normalizeDate(raw) {
    const value = (raw ?? '').trim();
    if (value === '')
        return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
function parseRss(root) {
    const channel = child(root, 'channel');
    if (channel === undefined)
        throw new FeedParseError('RSS document has no <channel>');
    const title = childText(channel, 'title');
    const items = [];
    for (const item of children(channel, 'item')) {
        const parsed = parseRssItem(item);
        if (parsed !== undefined)
            items.push(parsed);
    }
    return { title, items };
}
function parseRssItem(item) {
    const title = childText(item, 'title');
    const link = childText(item, 'link');
    const description = childText(item, 'description');
    // content:encoded appears under any namespace prefix; the encoded element
    // may also be plain (some generators expose <content>).
    let content = childText(item, 'encoded');
    if (content === '')
        content = childText(item, 'content');
    const guid = childText(item, 'guid');
    const publishedAt = normalizeDate(childText(item, 'pubDate'));
    if (title === '' && link === '' && description === '' && content === '')
        return undefined;
    return {
        title,
        link,
        summary: description,
        content,
        publishedAt,
        id: guid || link || contentHash(title, publishedAt),
    };
}
function parseAtom(root) {
    const title = childText(root, 'title');
    const items = [];
    for (const entry of children(root, 'entry')) {
        const parsed = parseAtomEntry(entry);
        if (parsed !== undefined)
            items.push(parsed);
    }
    return { title, items };
}
function parseAtomEntry(entry) {
    const title = childText(entry, 'title');
    const id = childText(entry, 'id');
    // Prefer rel="alternate", else the first <link> with an href.
    let link = '';
    for (const node of entry.children) {
        if (typeof node === 'string' || node.local !== 'link')
            continue;
        const href = node.attributes.href ?? '';
        if (href === '')
            continue;
        if (node.attributes.rel === undefined || node.attributes.rel === 'alternate') {
            link = href;
            break;
        }
    }
    const summary = childText(entry, 'summary');
    let content = childText(entry, 'content');
    if (content === '')
        content = childText(entry, 'description');
    const updated = normalizeDate(childText(entry, 'updated'));
    const published = normalizeDate(childText(entry, 'published'));
    if (title === '' && link === '' && summary === '' && content === '')
        return undefined;
    return {
        title,
        link,
        summary,
        content,
        publishedAt: published || updated,
        id: id || link || contentHash(title, published),
    };
}
function parseRdf(root) {
    const channel = child(root, 'channel');
    const title = channel === undefined ? '' : childText(channel, 'title');
    const items = [];
    for (const item of children(root, 'item')) {
        const titleText = childText(item, 'title');
        const link = childText(item, 'link');
        const description = childText(item, 'description');
        const publishedAt = normalizeDate(childText(item, 'date'));
        if (titleText === '' && link === '' && description === '')
            continue;
        items.push({
            title: titleText,
            link,
            summary: description,
            content: '',
            publishedAt,
            id: link || contentHash(titleText, publishedAt),
        });
    }
    return { title, items };
}
/** Stable 16-hex digest used as a fallback item identity. */
function contentHash(title, publishedAt) {
    let hash = 2166136261;
    const input = `${title}|${publishedAt}`;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `h${(hash >>> 0).toString(16)}`;
}
/**
 * Parse a feed document (RSS 2.0, RSS 1.0/RDF, or Atom).
 * @param body - the raw feed document text.
 * @throws {FeedParseError} when the document is not a recognizable feed.
 */
export function parseFeedDocument(body) {
    const root = parseXml(body);
    switch (root.local) {
        case 'rss':
            return parseRss(root);
        case 'feed':
            return parseAtom(root);
        case 'RDF':
            return parseRdf(root);
        default:
            throw new FeedParseError(`document root <${root.name}> is neither <rss>, <feed>, nor <RDF>`);
    }
}
/** HTML/XML sanitization helper: strip tags and collapse whitespace. */
export function stripHtml(html) {
    return decodeEntities(html)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
/** description 常见"查看原文"类引导文案（如 IT之家）——非正文摘要，剥掉 */
const LEAD_STUB_RE = /(?:…|\.{2,})?\s*(?:点击\s*(?:查看|阅读|标题)?\s*(?:查看|阅读)?原文|阅读原文|阅读全文|点击阅读全文|点击查看全文|查看全文|点击阅读|阅读详细|阅读更多|查看更多|查看详情|详情请点击|点此查看全文|read(?:\s+the)?\s+full\s+(?:article|story|post|content)|continue\s+reading|read\s+more|view\s+original)\s*(?:[>》»→›↗]|\.{1,3})*/gi;
export function stripLeadStub(text) {
    return text.replace(LEAD_STUB_RE, '').replace(/\s{2,}/g, ' ').trim();
}
/** "短正文"判定：汉字数 ≤ zh 且 英文单词数 ≤ en ——两种口径都短才算可疑（默认 10 字 / 6 词） */
export function isShortLead(text, zh = 10, en = 6) {
    const zhN = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
    const enN = (text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
    return zhN <= zh && enN <= en;
}
/** 无效名单匹配键：去全部空白/标点/符号 + 小写——"点击，查看原文" 与 "点击查看原文" 同键 */
export function leadKey(text) {
    return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
/** 内容命中无效名单：归一化后精确等值（不做包含匹配——防"广告"类词条误伤正常长文） */
export function inBlocklist(text, list) {
    const k = leadKey(text);
    return k.length >= 2 && list.some((e) => leadKey(e) === k);
}
/**
 * Truncate text to at most `max` code points without splitting a surrogate
 * pair (`.slice` on UTF-16 indices can leave a dangling half).
 */
export function truncateCodePoints(text, max) {
    if (text.length <= max)
        return text;
    const sliced = text.slice(0, max);
    // Drop a trailing lone surrogate left by slicing between a pair.
    return sliced.replace(/[\uD800-\uDBFF]$/, '');
}
//# sourceMappingURL=parser.js.map