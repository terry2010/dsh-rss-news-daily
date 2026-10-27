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

import { createHash } from 'node:crypto'

/** strip NUL characters etc. that are not meaningful in headlines. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/g

/** Unicode-aware letters/numbers (including CJK), used to split tokens. */
const TOKEN_SPLIT_RE = /[^\p{L}\p{N}]+/gu

const LATIN_SCRIPT_RE = /^[\p{Script=Latin}\p{Script=Common}\p{N}]+$/u

/**
 * Canonicalize a text so that equivalent headlines produce the same string.
 * Unicode normalization, case folding, whitespace collapse, punctuation drop.
 */
export function normalizeText(text: string): string {
  const cleaned = (text ?? '')
    .normalize('NFKC')
    .replace(CONTROL_RE, ' ')
    .trim()
  // Latin-script text: words are the natural tokens.
  if (LATIN_SCRIPT_RE.test(cleaned.replace(TOKEN_SPLIT_RE, ''))) {
    return cleaned.toLowerCase().replace(TOKEN_SPLIT_RE, ' ').trim().replace(/\s+/g, ' ')
  }
  // CJK / mixed text: drop separator characters entirely so "你好 世界"
  // and "你好，世界" are equal (CJK rarely needs word boundaries).
  return cleaned.replace(TOKEN_SPLIT_RE, '')
}

/** sha1 hex digest of any string — the exact-match dedup token. */
export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/** Split text into tokens for similarity computation. */
function tokenize(text: string): Set<string> {
  const cleaned = normalizeText(text)
  if (cleaned === '') return new Set()
  if (LATIN_SCRIPT_RE.test(cleaned.replace(TOKEN_SPLIT_RE, ''))) {
    return new Set(cleaned.split(' ').filter((token) => token.length > 0))
  }
  // CJK: character bigrams capture word boundaries reasonably well.
  const tokens = new Set<string>()
  for (let index = 0; index + 1 < cleaned.length; index += 1) {
    tokens.add(cleaned.slice(index, index + 2))
  }
  if (tokens.size === 0 && cleaned.length === 1) tokens.add(cleaned)
  return tokens
}

/** Jaccard similarity between two token sets: |A ∩ B| / |A ∪ B| ∈ [0, 1]. */
export function tokenSimilarity(left: string, right: string): number {
  const a = tokenize(left)
  const b = tokenize(right)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Compute the exact-match dedup hash for one item. Title dominates; when the
 * title is empty or the caller opts into content comparison, the body text is
 * blended in so identical bodies without headlines still collapse.
 */
export function itemHash(title: string, body: string, compareContent: boolean): string {
  const titlePart = normalizeText(title)
  if (!compareContent || titlePart !== '') {
    return hashText(`t:${titlePart}`)
  }
  return hashText(`b:${normalizeText(body).slice(0, 1024)}`)
}

/** Options controlling duplicate decisions. */
export interface DedupeOptions {
  /** Minimum Jaccard similarity for two items to count as duplicates. */
  threshold: number
  /** Whether body text participates in exact-hash fallback determination. */
  compareContent: boolean
}

/**
 * Decide whether a candidate title/body duplicates a known item title/body.
 * Exact-match wins; fuzzy match is subject to the threshold (0..1).
 * @returns the matched known title when a duplicate exists, else undefined.
 */
export function findDuplicate(
  candidate: { title: string; hash: string },
  known: { title: string; hash: string }[],
  options: DedupeOptions,
): { title: string; hash: string } | undefined {
  const exact = known.find((item) => item.hash === candidate.hash)
  if (exact !== undefined) return exact
  const threshold = Math.max(0, Math.min(1, options.threshold))
  for (const item of known) {
    if (tokenSimilarity(candidate.title, item.title) >= threshold) {
      return item
    }
  }
  return undefined
}