/**
 * Minimal HTTP document fetcher for feed polling.
 *
 * Uses the platform `fetch` (Node >= 22, browsers) with a cooperative timeout,
 * a response size cap, charset detection (UTF-8 by default with fallbacks),
 * and a small retry-with-backoff loop for transient failures. The fetch
 * implementation is injectable so tests can exercise every branch without a
 * network.
 *
 * Pure module apart from `globalThis.fetch` and Node's TextDecoder: no dsh
 * dependency.
 */

import type { FetchFailure, FetchedDocument } from './types.js'
import { ssrfRejectReason } from './ssrf.js'

/** Structured error thrown internally; callers receive {@link FetchFailure}. */
class FeedFetchError extends Error {
  /** When false, retrying the same request cannot succeed. */
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'FeedFetchError'
    this.retryable = retryable
  }
}

export interface FetcherOptions {
  /** Abort the request after this many milliseconds (default 15_000). */
  timeoutMs?: number
  /** Refuse documents larger than this many bytes (default 1 MiB). */
  sizeLimitBytes?: number
  /** Number of retries after transient failures (default 2). */
  retries?: number
  /** User-Agent header value. */
  userAgent?: string
  /** Injectable fetch for tests / transports. */
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_SIZE_LIMIT = 1024 * 1024
const DEFAULT_RETRIES = 2
const DEFAULT_USER_AGENT = 'dsh-rss-digest/0.1 (+https://github.com/deepseek-ai/deepseek-harness)'
const CHARSET_PROBE_BYTES = 512

/** Whether an HTTP status is worth retrying (5xx/429/408). */
function isTransient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Select a TextDecoder honoring Content-Type or XML declaration hints. */
function pickDecoder(contentType: string | null, head: Uint8Array): InstanceType<typeof TextDecoder> {
  let encoding: string | undefined
  const header = /charset\s*=\s*["']?([a-zA-Z0-9._-]+)["']?/i.exec(contentType ?? '')
  if (header !== null) encoding = header[1]
  if (encoding === undefined) {
    const probe = new TextDecoder().decode(head)
    const declaration = /<\?xml[^>]*encoding\s*=\s*["']([a-zA-Z0-9._-]+)["']/.exec(probe)
    if (declaration !== null) encoding = declaration[1]
  }
  if (encoding === undefined) encoding = 'utf-8'
  try {
    return new TextDecoder(encoding)
  } catch {
    return new TextDecoder()
  }
}

/**
 * Read a fetch response body, enforcing a byte budget.
 *
 * The charset is detected once (Content-Type header, else the first 512
 * bytes' XML declaration), and a SINGLE TextDecoder instance then decodes
 * every chunk with stream state — so multi-byte characters split across
 * stream boundaries never corrupt. `signal` aborts the read mid-stream.
 */
async function readBody(
  body: ReadableStream<Uint8Array> | null,
  contentType: string | null,
  sizeLimit: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (body === null) return ''
  const reader = body.getReader()
  const onAbort = (): void => {
    void reader.cancel().catch(() => {})
  }
  if (signal !== undefined && signal.aborted) {
    onAbort()
  } else {
    signal?.addEventListener('abort', onAbort, { once: true })
  }
  try {
    let bytes = 0
    let head = new Uint8Array(0)
    let decoder: InstanceType<typeof TextDecoder> | undefined
    // Bytes received before the decoder is selected; bounded by `sizeLimit`
    // via the byte counter below.
    const buffered: Uint8Array[] = []
    const chunks: string[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const next = value ?? new Uint8Array(0)
      bytes += next.byteLength
      if (bytes > sizeLimit) {
        throw new FeedFetchError(`response larger than ${sizeLimit} bytes`, false)
      }
      if (decoder === undefined) {
        buffered.push(next)
        if (head.byteLength < CHARSET_PROBE_BYTES) {
          const take = Math.min(next.byteLength, CHARSET_PROBE_BYTES - head.byteLength)
          const merged = new Uint8Array(head.byteLength + take)
          merged.set(head, 0)
          merged.set(next.subarray(0, take), head.byteLength)
          head = merged
        }
        if (head.byteLength >= CHARSET_PROBE_BYTES) {
          decoder = pickDecoder(contentType, head)
        }
      } else {
        chunks.push(decoder.decode(next, { stream: true }))
      }
    }
    decoder ??= pickDecoder(contentType, head)
    for (const bufferedChunk of buffered) {
      chunks.push(decoder.decode(bufferedChunk, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

/** Create a fetch function with the given policies. */
export function createFetcher(options: FetcherOptions = {}) {
  const fetchImpl: typeof fetch = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const sizeLimit = options.sizeLimitBytes ?? DEFAULT_SIZE_LIMIT
  const retries = options.retries ?? DEFAULT_RETRIES
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT

  const fetchOne = async (url: string, signal?: AbortSignal): Promise<FetchedDocument | FetchFailure> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const combined = signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, signal])
    try {
      // 手动跟随重定向：每一跳都过 SSRF，防"公网 302 到内网"穿透（audit M1-H2）
      let current = url
      let response: Response | undefined
      for (let hop = 0; hop <= 5; hop += 1) {
        const blocked = ssrfRejectReason(current)
        if (blocked) return { url, status: 0, error: `SSRF blocked: ${blocked}`, retryable: false }
        response = await fetchImpl(current, {
          headers: {
            'user-agent': userAgent,
            accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
          },
          redirect: 'manual',
          signal: combined,
        })
        if (response.status >= 300 && response.status < 400) {
          const loc = response.headers.get('location')
          if (!loc) break
          current = new URL(loc, current).toString()
          continue
        }
        break
      }
      if (!response) return { url, status: 0, error: 'no response', retryable: false }
      if (response.status >= 300 && response.status < 400) {
        return { url, status: response.status, error: `too many redirects`, retryable: false }
      }
      if (!response.ok) {
        return { url, status: response.status, error: `HTTP ${response.status} ${response.statusText}`.trim() }
      }
      const body = await readBody(response.body, response.headers.get('content-type'), sizeLimit, combined)
      return { url, status: response.status, body }
    } catch (error) {
      if (error instanceof FeedFetchError) {
        return { url, status: 0, error: error.message, retryable: error.retryable }
      }
      // A caller abort must never be retried.
      return {
        url,
        status: 0,
        error: errorMessage(error),
        retryable: signal !== undefined && signal.aborted ? false : undefined,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Fetch a URL, returning a document or a structured failure. `signal`
   * aborts the whole attempt chain; only transient failures are retried.
   */
  return async function fetchDocument(url: string, signal?: AbortSignal): Promise<FetchedDocument | FetchFailure> {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const result = await fetchOne(url, signal)
      if (!('error' in result)) return result
      const retryable = (result.retryable ?? true) && isTransient(result.status)
      if (attempt === retries || !retryable || (signal !== undefined && signal.aborted)) {
        return result
      }
      await delay(400 * 2 ** attempt)
    }
    // Unreachable: the loop either returned or fell through with attempt === retries.
    return { url, status: 0, error: 'network failure' }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}