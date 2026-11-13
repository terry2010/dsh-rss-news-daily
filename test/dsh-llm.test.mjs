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

// ---- 全局并发信号量（llmConcurrency）----
const mkGate = () => { let r; const p = new Promise((res) => { r = res }); return { p, r } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const promptOf = (v) => v.prompt ?? v.messages?.[0]?.content?.[0]?.text // stream 入参是 messages 结构（createUserMessage 折叠 prompt）
const mkStreamLlm = (started, gates = new Map()) => ({
  listProviders: () => [{ id: 'p' }],
  listModels: async () => [{ id: 'm' }],
  stream: async function* (v) {
    const key = promptOf(v)
    started.push(key)
    await gates.get(key)?.p // 未放行的调用挂在生成器里（模拟在飞请求）
    yield { type: 'text-delta', text: `ok:${key}` }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})

test('LLM 信号量: 默认串行——排队 FIFO，前一个在飞后者不启动', async () => {
  const { DshLlmClient, setLlmConcurrency } = await import('../lib/dsh-llm.js')
  setLlmConcurrency(() => 1)
  const started = []
  const gates = new Map([['p1', mkGate()], ['p2', mkGate()]])
  const client = new DshLlmClient(mkStreamLlm(started, gates), { provider: 'p', model: 'm' }, silentLog)
  const c1 = client.generateText({ prompt: 'p1' })
  await sleep(30)
  const c2 = client.generateText({ prompt: 'p2' })
  await sleep(30)
  assert.deepEqual(started, ['p1']) // p2 排队中，未进流
  gates.get('p1').r()
  assert.equal(await c1, 'ok:p1')
  await sleep(30)
  assert.deepEqual(started, ['p1', 'p2']) // FIFO：p1 释放后 p2 才启动
  gates.get('p2').r()
  assert.equal(await c2, 'ok:p2')
})

test('LLM 信号量: 排队中 abort——撤出不占槽、不执行，后位正常放行', async () => {
  const { DshLlmClient, setLlmConcurrency } = await import('../lib/dsh-llm.js')
  setLlmConcurrency(() => 1)
  const started = []
  const gates = new Map([['a1', mkGate()], ['a2', mkGate()], ['a3', mkGate()]])
  const client = new DshLlmClient(mkStreamLlm(started, gates), { provider: 'p', model: 'm' }, silentLog)
  const ac = new AbortController()
  const c1 = client.generateText({ prompt: 'a1' })
  await sleep(30)
  const c2 = client.generateText({ prompt: 'a2', signal: ac.signal })
  const c3 = client.generateText({ prompt: 'a3' })
  await sleep(30)
  ac.abort()
  await assert.rejects(c2, /aborted/) // 仍在队列：拒绝而不消耗槽位
  gates.get('a1').r(); await c1
  await sleep(30)
  gates.get('a3').r(); assert.equal(await c3, 'ok:a3')
  assert.deepEqual(started, ['a1', 'a3']) // a2 从未进流
})

test('LLM 信号量: 并发=2 时两个调用并行启动，第三个排队', async () => {
  const { DshLlmClient, setLlmConcurrency } = await import('../lib/dsh-llm.js')
  setLlmConcurrency(() => 2)
  const started = []
  const gates = new Map([['b1', mkGate()], ['b2', mkGate()], ['b3', mkGate()]])
  const client = new DshLlmClient(mkStreamLlm(started, gates), { provider: 'p', model: 'm' }, silentLog)
  const calls = ['b1', 'b2', 'b3'].map((p) => client.generateText({ prompt: p }))
  await sleep(40)
  assert.deepEqual(started.sort(), ['b1', 'b2']) // b3 等槽
  gates.get('b1').r(); gates.get('b2').r()
  await sleep(40)
  assert.equal(started.length, 3)
  gates.get('b3').r()
  await Promise.all(calls)
  setLlmConcurrency(() => 1) // 复位，不污染同文件后续测试
})

test('LLM 队列快照: 按 tag 集合区分本任务的执行中/排队中/前方调用数', async () => {
  const { DshLlmClient, setLlmConcurrency, llmQueueSnapshot } = await import('../lib/dsh-llm.js')
  setLlmConcurrency(() => 1)
  const started = []
  const gates = new Map([['q1', mkGate()], ['q2', mkGate()], ['t1', mkGate()]])
  const fetch = new DshLlmClient(mkStreamLlm(started, gates), { provider: 'p', model: 'm' }, silentLog, 'translate')
  const topic = new DshLlmClient(mkStreamLlm(started, gates), { provider: 'p', model: 'm' }, silentLog, 'topic')
  const c1 = fetch.generateText({ prompt: 'q1', purpose: 'score' })
  const c2 = fetch.generateText({ prompt: 'q2', purpose: 'score' })
  const c3 = topic.generateText({ prompt: 't1', purpose: 'topic-chunk' })
  await sleep(40)
  // q1 在飞，队列 [q2, t1]：topic 视角——0 执行 1 排队，前方=1 个队列位 + q1 在飞 = 2
  let s = llmQueueSnapshot(['topic'])
  assert.equal(s.tagRunning, 0); assert.equal(s.tagQueued, 1); assert.equal(s.tagAhead, 2)
  assert.deepEqual(s.mineQueued, ['topic-chunk']) // 明细：本任务排队的是哪次调用
  assert.deepEqual(s.ahead, ['score', 'score']) // 前方=q1在飞 + q2排在前
  // fetch 视角——自己的 q1 在飞不算"他人前方"：ahead=0
  s = llmQueueSnapshot(['translate', 'score'])
  assert.equal(s.tagRunning, 1); assert.equal(s.tagQueued, 1); assert.equal(s.tagAhead, 0)
  assert.deepEqual(s.mineQueued, ['score']); assert.deepEqual(s.ahead, [])
  gates.get('q1').r(); await c1
  await sleep(40)
  // q2 上位在飞，t1 队首：topic 前方只剩 q2 = 1
  s = llmQueueSnapshot(['topic'])
  assert.equal(s.tagRunning, 0); assert.equal(s.tagQueued, 1); assert.equal(s.tagAhead, 1)
  gates.get('q2').r(); await c2
  await sleep(40)
  // t1 在飞：topic 0 排队 0 前方
  s = llmQueueSnapshot(['topic'])
  assert.equal(s.tagRunning, 1); assert.equal(s.tagQueued, 0); assert.equal(s.tagAhead, 0)
  gates.get('t1').r(); assert.equal(await c3, 'ok:t1')
})

test('推理模型自救: 空补全+reasoning → 放大 maxTokens 重试一次', async () => {
  const { DshLlmClient } = await import('../lib/dsh-llm.js')
  const seen = []
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    stream: async function* (v) {
      seen.push({ maxTokens: v.maxTokens, prompt: v.messages[0].content[0].text })
      if (seen.length === 1) {
        yield { type: 'reasoning-delta', text: '想'.repeat(500) } // reasoning 吃光 64 token 预算，正文零输出
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', text: 'done' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const client = new DshLlmClient(llm, { provider: 'p', model: 'm' }, silentLog)
  assert.equal(await client.generateText({ prompt: 'p', maxTokens: 64 }), 'done')
  assert.equal(seen.length, 2)
  assert.ok(seen[1].maxTokens > 64, `retry should boost maxTokens, got ${seen[1].maxTokens}`)
})

test('推理模型自救: 推理被截流 → 分析尾巴折回 prompt 续写', async () => {
  const { DshLlmClient } = await import('../lib/dsh-llm.js')
  const seen = []
  const marker = ' [49]：A股概念受冲击、股价跌超4%市值蒸发1800亿、散户买盘增40倍。OK。'
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    stream: async function* (v) {
      seen.push({ maxTokens: v.maxTokens, prompt: v.messages[0].content[0].text })
      if (seen.length === 1) {
        yield { type: 'reasoning-delta', text: 'z'.repeat(2500) + marker }
        throw new Error('LLM reasoning loop detected: pool — sentence pool repeat; ev="x" (reasoning 2560 chars)')
      }
      yield { type: 'text-delta', text: 'final report' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const client = new DshLlmClient(llm, { provider: 'p', model: 'm' }, silentLog)
  assert.equal(await client.generateText({ prompt: 'p', maxTokens: 8192 }), 'final report')
  assert.equal(seen.length, 2)
  assert.ok(seen[1].prompt.includes('续写指令'), 'continuation prompt should carry the directive')
  assert.ok(seen[1].prompt.includes('A股概念受冲击'), 'analysis tail should be folded into prompt')
  assert.ok(seen[1].maxTokens > 8192)
})

test('LLM 耗时统计: 成功调用按 purpose 记录均值，作为进度 ETA 数据源', async () => {
  const { DshLlmClient, llmCallAvgMs } = await import('../lib/dsh-llm.js')
  const client = new DshLlmClient(mkStreamLlm([], new Map()), { provider: 'p', model: 'm' }, silentLog)
  await client.generateText({ prompt: 'e1', purpose: 'eta-probe' })
  const v = llmCallAvgMs('eta-probe')
  assert.equal(typeof v, 'number')
  assert.ok(v >= 0)
})
