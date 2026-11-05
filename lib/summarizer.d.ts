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
import type { DigestLanguage, SummaryMode } from './core/types.js';
/** A display-ready item view sent to the summarizer. */
export interface SummarizableItem {
    title: string;
    link: string;
    summary: string;
    content: string;
    sourceTitle: string;
    publishedAt: string;
    /** 分类/领域（领域分块总结用）；缺省按"综合" */
    topic?: string;
    /** 抓取时刻 HH:mm（时间线式总结用） */
    hour?: string;
}
export interface SummarizeRequest {
    items: SummarizableItem[];
    language: DigestLanguage;
    mode: SummaryMode;
    maxLength: number;
    /** 附加指令（热点提示/时间线组织等），拼到 prompt 尾部 */
    notes?: string;
    /** Token budget hint for the model call. */
    maxTokens?: number;
    /** Abort signal forwarded to the model call when supported. */
    signal?: AbortSignal;
}
export interface SummarizeResult {
    text: string;
    source: 'llm' | 'extractive';
    error?: string;
}
/** The single seam through which this package talks to a text model. */
export interface LlmClient {
    generateText(request: LlmTextRequest): Promise<string>;
}
export interface LlmTextRequest {
    system?: string;
    prompt: string;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
}
/** Render the prompt body for a request. */
export declare function buildPrompt(request: SummarizeRequest): {
    system: string;
    prompt: string;
};
/**
 * Extractive fallback summary: titled bullet lines with the first meaningful
 * sentence of every item, bounded by `maxLength`.
 */
export declare function extractiveSummary(items: SummarizableItem[], language: DigestLanguage, maxLength: number): string;
/** Bound a string to `chars` characters (code points) at a safe boundary. */
export declare function truncateText(text: string, chars: number): string;
/**
 * Summarize items. Uses the model when enabled; any model failure degrades to
 * the extractive summary. Never throws.
 */
export declare function summarize(request: SummarizeRequest, client: LlmClient | undefined, llmEnabled: boolean): Promise<SummarizeResult>;
//# sourceMappingURL=summarizer.d.ts.map