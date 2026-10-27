/**
 * Adapter that routes summarization through the host's `ctx.llm` service.
 *
 * Provider/model resolution is deferred to the first call so that HMR or late
 * registrations (e.g. the DeepSeek adapter activating after startup) are
 * honored. When no adapter is registered yet the call fails loudly and the
 * summarizer degrades to its extractive fallback.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'

class RssServiceError extends Error {}
import type { LlmClient, LlmTextRequest } from './summarizer.js'
import type { LogSink } from './core/types.js'

export interface DshLlmRoute {
  provider: string
  model: string
}

/** Pick a live provider/model pair honoring configured values. */
export async function resolveDshRoute(
  llm: LlmRuntime,
  route: DshLlmRoute,
): Promise<{ provider: string; model: string }> {
  // 成对校验：只填一个视为都未配置（走宿主默认路由，不猜半个配置）
  let provider = route.provider
  let model = route.model
  if (provider === '' || model === '') {
    provider = ''
    model = ''
  }
  if (provider === '') {
    const providers = llm.listProviders()
    const first = providers[0]
    if (first === undefined) {
      throw new RssServiceError('no LLM provider is registered in this dsh instance')
    }
    provider = (providers.find((entry) => /deepseek|official/i.test(entry.id)) ?? first).id
  }
  if (model === '') {
    const models = await llm.listModels(provider).catch(() => [])
    const first = models[0]
    if (first !== undefined) {
      model = (models.find((entry) => /chat|flash|deepseek|v3|r1|pro/i.test(entry.id)) ?? first).id
    }
  }
  if (model === '') {
    throw new RssServiceError(`provider ${provider} lists no model; configure summary.model`)
  }
  return { provider, model }
}

/** Accumulate a stream into plain text, surfacing terminal failures. usage 传入对象则原地累计 token 用量（流中 usage 为累计值，取最新）。 */
export async function collectText(stream: AsyncIterable<StreamChunk>, usage?: { inputTokens: number; outputTokens: number; _seen?: number; _seenOut?: number }): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    const u = (chunk as { usage?: { inputTokens?: number; outputTokens?: number } }).usage
    if (usage && u) {
      if (typeof u.inputTokens === 'number') usage.inputTokens += u.inputTokens - (usage._seen ?? 0) // 累计值取增量
      if (typeof u.outputTokens === 'number') usage.outputTokens += u.outputTokens - (usage._seenOut ?? 0)
      if (typeof u.inputTokens === 'number') usage._seen = u.inputTokens
      if (typeof u.outputTokens === 'number') usage._seenOut = u.outputTokens
    }
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text
        break
      case 'reasoning-delta':
        // Reasoning deltas are not part of the visible answer.
        break
      case 'finish':
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          throw new RssServiceError(
            `LLM call failed: ${chunk.reason.kind}: ${chunk.reason.failure.message} (${chunk.reason.failure.code})`,
          )
        }
        break
      default:
        break
    }
  }
  if (text.trim() === '') throw new RssServiceError('LLM returned an empty completion')
  return text
}

/** {@link LlmClient} backed by the harness `ctx.llm` streaming service. */
export class DshLlmClient implements LlmClient {
  private readonly llm: LlmRuntime
  private readonly route: DshLlmRoute
  private readonly log: LogSink
  private resolution?: { provider: string; model: string }
  /** 本 client 生命周期内的累计 token 用量（pipeline 每次 digest 新建实例 → 即单次日报用量） */
  readonly usage: { inputTokens: number; outputTokens: number; _seen?: number; _seenOut?: number } = { inputTokens: 0, outputTokens: 0 }

  constructor(llm: LlmRuntime, route: DshLlmRoute, log: LogSink) {
    this.llm = llm
    this.route = route
    this.log = log
  }

  async generateText(request: LlmTextRequest): Promise<string> {
    const route = this.resolution ??= await resolveDshRoute(this.llm, this.route)
    this.log.info(`LLM summary via provider=${route.provider} model=${route.model}`)
    const message = createUserMessage({
      content: [{ type: 'text', text: request.prompt }],
      source: { kind: 'user' },
    })
    const stream = this.llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [message],
      system: request.system,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    })
    return collectText(stream, this.usage)
  }
}