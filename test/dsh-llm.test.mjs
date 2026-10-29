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
