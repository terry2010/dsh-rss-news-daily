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

test('devLog: 开启后写完整对话 JSONL（prompt/response/token/速度），关闭不写', async () => {
  const { mkdtempSync, readdirSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'devlog-test-'))
  const mod = await import('../lib/dsh-llm.js')
  const { DshLlmClient } = mod
  mod.setDevLogDir(dir)
  mod.setDevLogEnabled(() => false)
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    stream: async function* () {
      yield { type: 'text-delta', text: 'partial answer', usage: { inputTokens: 10, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } }
    },
  }
  const client = new DshLlmClient(llm, { provider: 'p', model: 'm' }, silentLog, 'score')
  // 关闭状态：调用失败也不落盘
  await assert.rejects(client.generateText({ system: 'sys', prompt: 'pr', purpose: 'score' }), /boom/)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(readdirSync(dir).filter((n) => n.endsWith('.jsonl')).length, 0)
  // 开启后：失败调用记录 ok:false + partial response + token/速度字段
  mod.setDevLogEnabled(() => true)
  await assert.rejects(client.generateText({ system: 'sys', prompt: 'pr', purpose: 'score' }), /boom/)
  let file
  for (let i = 0; i < 20 && !file; i++) {
    await new Promise((r) => setTimeout(r, 50))
    file = readdirSync(dir).find((n) => /^dev-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
  }
  assert.ok(file, 'dev-*.jsonl not written')
  const rec = JSON.parse(readFileSync(join(dir, file), 'utf8').trim().split('\n').pop())
  assert.equal(rec.ok, false)
  assert.equal(rec.tag, 'score')
  assert.equal(rec.purpose, 'score')
  assert.equal(rec.provider, 'p')
  assert.equal(rec.model, 'm')
  assert.equal(rec.system, 'sys')
  assert.equal(rec.prompt, 'pr')
  assert.equal(rec.response, 'partial answer') // 失败也保留已收到的部分输出
  assert.match(rec.error, /boom/)
  assert.match(rec.ts, /[+-]\d{2}:\d{2}$/) // 本地时区 ISO（含偏移，非 UTC Z）
  assert.equal(typeof rec.ms, 'number')
  assert.equal(typeof rec.in, 'number')
  assert.equal(typeof rec.out, 'number')
  mod.setDevLogEnabled(() => false)
})
