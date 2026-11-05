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
import type { FetchFailure, FetchedDocument } from './types.js';
export interface FetcherOptions {
    /** Abort the request after this many milliseconds (default 15_000). */
    timeoutMs?: number;
    /** Refuse documents larger than this many bytes (default 1 MiB). */
    sizeLimitBytes?: number;
    /** Number of retries after transient failures (default 2). */
    retries?: number;
    /** User-Agent header value. */
    userAgent?: string;
    /** Injectable fetch for tests / transports. */
    fetchImpl?: typeof fetch;
    /** 全局代理（http://…），源级 proxy:true 时使用；可为取值函数（UI prefs 动态读取）；SOCKS5 不支持 */
    proxyUrl?: string | (() => string | undefined);
}
/** Create a fetch function with the given policies. */
export declare function createFetcher(options?: FetcherOptions): (url: string, signal?: AbortSignal, init?: {
    proxy?: string | boolean;
}) => Promise<FetchedDocument | FetchFailure>;
//# sourceMappingURL=fetcher.d.ts.map