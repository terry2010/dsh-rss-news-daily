/**
 * Text normalization and near-duplicate detection for news items.
 *
 * Strategy:
 *  - `normalizeText()` canonicalizes a headline for exact matching
 *    (case folding, whitespace collapse, punctuation removal).
 *  - Exact dedup compares a canonical hash.
 *  - Fuzzy dedup compares token-set Jaccard similarity against a threshold;
 *    CJK text is tokenized into character bigrams so Chinese headlines are
 *    compared meaningfully, while Latin text is tokenized into words.
 *
 * Pure module: no I/O, no dsh dependency.
 */
/**
 * Canonicalize a text so that equivalent headlines produce the same string.
 * Unicode normalization, case folding, whitespace collapse, punctuation drop.
 */
export declare function normalizeText(text: string): string;
/** sha1 hex digest of any string — the exact-match dedup token. */
export declare function hashText(text: string): string;
/** Jaccard similarity between two token sets: |A ∩ B| / |A ∪ B| ∈ [0, 1]. */
export declare function tokenSimilarity(left: string, right: string): number;
/**
 * Compute the exact-match dedup hash for one item. Title dominates; when the
 * title is empty or the caller opts into content comparison, the body text is
 * blended in so identical bodies without headlines still collapse.
 */
export declare function itemHash(title: string, body: string, compareContent: boolean): string;
/** Options controlling duplicate decisions. */
export interface DedupeOptions {
    /** Minimum Jaccard similarity for two items to count as duplicates. */
    threshold: number;
    /** Whether body text participates in exact-hash fallback determination. */
    compareContent: boolean;
}
/**
 * Decide whether a candidate title/body duplicates a known item title/body.
 * Exact-match wins; fuzzy match is subject to the threshold (0..1).
 * @returns the matched known title when a duplicate exists, else undefined.
 */
export declare function findDuplicate(candidate: {
    title: string;
    hash: string;
}, known: {
    title: string;
    hash: string;
}[], options: DedupeOptions): {
    title: string;
    hash: string;
} | undefined;
//# sourceMappingURL=dedupe.d.ts.map