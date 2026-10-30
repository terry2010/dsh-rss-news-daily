import { test } from 'node:test'
import assert from 'node:assert/strict'

const silentLog = { info() {}, warn() {}, error() {} }

test('LLM route: 自动选择首选 provider/model，成对配置与无 provider 错误路径', async () => {
  const { resolveDshRoute } = await import('../lib/dsh-llm.js')
  const llm = {
    listProviders: () => [{ id: 'other' }, { id: 'official-deepseek' }],
    listModels: async (provider) => {
      assert.equal(provider, 'official-deepseek')
      return [{ id: 'basic' }, { id: 'chat-v3' }]
    },
  }
  assert.deepEqual(await resolveDshRoute(llm, { provider: '', model: '' }), { provider: 'official-deepseek', model: 'chat-v3' })
  assert.deepEqual(await resolveDshRoute(llm, { provider: 'custom', model: 'fixed' }), { provider: 'custom', model: 'fixed' })
  await assert.rejects(resolveDshRoute({ listProviders: () => [], listModels: async () => [] }, { provider: '', model: '' }), /no LLM provider/)
  await assert.rejects(resolveDshRoute({ listProviders: () => [{ id: 'p' }], listModels: async () => { throw new Error('offline') } }, { provider: '', model: '' }), /lists no model/)
})

test('DshLlmClient: 转发路由/请求/取消信号，累计流式文本与 token 用量', async () => {
  const { DshLlmClient } = await import('../lib/dsh-llm.js')
  const controller = new AbortController()
  let request
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    stream: async function* (value) {
      request = value
      yield { type: 'text-delta', text: 'hello', usage: { inputTokens: 8, outputTokens: 1 } }
      yield { type: 'text-delta', text: ' world', usage: { inputTokens: 8, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const client = new DshLlmClient(llm, { provider: '', model: '' }, silentLog)
  const result = await client.generateText({ system: 'system', prompt: 'prompt', maxTokens: 123, temperature: 0.2, signal: controller.signal })
  assert.equal(result, 'hello world')
  assert.equal(request.provider, 'p')
  assert.equal(request.model, 'm')
  assert.equal(request.system, 'system')
  assert.equal(request.maxTokens, 123)
  assert.equal(request.temperature, 0.2)
  assert.equal(request.signal, controller.signal)
  assert.equal(client.usage.inputTokens, 8)
  assert.equal(client.usage.outputTokens, 3)
})

test('DshLlmClient: 模型不支持 system 首条时折进 user 重试（translategemma 类）', async () => {
  const { DshLlmClient } = await import('../lib/dsh-llm.js')
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'omlx' }],
    listModels: async () => [{ id: 'translategemma-4b-it-4bit' }],
    stream: async function* (value) {
      calls.push(value)
      if (value.system !== undefined) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'omlx API error (400): {"message":"Chat template error: Conversations must start with a user prompt."}', code: 'INVALID_REQUEST' } } }
        return
      }
      yield { type: 'text-delta', text: '标题：译题\n正文：译文' }
    },
  }
  const client = new DshLlmClient(llm, { provider: '', model: '' }, silentLog)
  const text = await client.generateText({ system: '你是翻译助手', prompt: '标题：hello\n\n正文：world' })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].system, '你是翻译助手')
  assert.equal(calls[1].system, undefined) // 重试不再带 system
  assert.equal(calls[1].messages[0].content[0].text, '你是翻译助手\n\n标题：hello\n\n正文：world')
  assert.equal(text, '标题：译题\n正文：译文')
})

test('DshLlmClient: 非模板类错误不触发 system 折叠重试', async () => {
  const { DshLlmClient } = await import('../lib/dsh-llm.js')
  let calls = 0
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    stream: async function* () {
      calls++
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'HTTP 500 internal', code: 'INTERNAL' } } }
    },
  }
  const client = new DshLlmClient(llm, { provider: '', model: '' }, silentLog)
  await assert.rejects(client.generateText({ system: 's', prompt: 'p' }), /HTTP 500/)
  assert.equal(calls, 1) // 不重试
})
