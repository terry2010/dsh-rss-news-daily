import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const YAML_BASE = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: omlx
    model: Ornith-1.5-35B-A3B-BigBang-MTP-mlx-4bit
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      omlx:
        displayName: oMLX
        api: openai-responses
        baseURL: http://127.0.0.1:8001/v1
        apiKeyEnv: OMLX_API_KEY
        models:
          - id: Huihui-Ornith-1.5-35B-A3B-abliterated
            name: Huihui-Ornith-1.5-35B-A3B-abliterated
            contextWindow: 262144
            maxTokens: 32768
            input:
              - text
              - image
          - id: Ornith-1.5-35B-A3B-BigBang-MTP-mlx-4bit
            name: Ornith-1.5-35B-A3B-BigBang-MTP-mlx-4bit
            contextWindow: 131072
            maxTokens: 16384
            input:
              - text
              - image
          - id: translategemma-4b-it-4bit
            name: translategemma-4b-it-4bit
            contextWindow: 131072
            maxTokens: 32768
            input:
              - text
      strata:
        displayName: strata
        api: anthropic-messages
        baseURL: http://localhost:8002
        models:
          - id: q2_0
            name: qwen3.8_flash_q2_0
            input:
              - text
            reasoningEfforts:
              off: null
              low: low
        apiKeyEnv: STRATA_API_KEY
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: ddg
`

test('patchCordisText: openai-responses 模型插入 minimal:"none" 档位梯度', async () => {
  const { patchCordisText } = await import('../lib/effort-config.js')
  const r = patchCordisText(YAML_BASE, 'omlx', 'Ornith-1.5-35B-A3B-BigBang-MTP-mlx-4bit')
  assert.ok(r.text, `expected text, got ${JSON.stringify(r)}`)
  assert.equal(r.api, 'openai-responses')
  const out = r.text
  // 插到目标模型块内（在 maxTokens 后、input 前的字段层）
  assert.match(out, /Ornith-1\.5-35B-A3B-BigBang-MTP-mlx-4bit\n(?:.*\n)*? {12}reasoningEfforts:\n {14}minimal: "none"\n {14}low: "low"\n {14}medium: "medium"\n {14}high: "high"/)
  // 没有 compat 字段（responses 方言不需要）
  assert.equal((out.match(/reasoningEfforts:/g) || []).length, 2) // strata 原有 + 新增
  // 其他模型未受影响：translategemma 条目块内没有 reasoningEfforts
  const tg = out.indexOf('translategemma-4b-it-4bit')
  const tgEnd = out.indexOf('strata:', tg)
  assert.ok(!out.slice(tg, tgEnd).includes('reasoningEfforts'))
})

test('patchCordisText: 已声明 reasoningEfforts 的模型返回 exists 不重复写', async () => {
  const { patchCordisText } = await import('../lib/effort-config.js')
  const r = patchCordisText(YAML_BASE, 'strata', 'q2_0')
  assert.equal(r.exists, true)
  assert.equal(r.api, 'anthropic-messages')
  assert.equal(r.text, undefined)
})

test('patchCordisText: anthropic-messages 方言生成 off:null 关断档', async () => {
  const { patchCordisText } = await import('../lib/effort-config.js')
  // 换一个没有 reasoningEfforts 的 anthropic 模型
  const yaml = YAML_BASE.replace('strata:', 'kaggle:')
    .replace('            reasoningEfforts:\n              off: null\n              low: low\n', '')
  const r = patchCordisText(yaml, 'kaggle', 'q2_0')
  assert.ok(r.text, `expected text, got ${JSON.stringify(r)}`)
  assert.equal(r.api, 'anthropic-messages')
  assert.match(r.text, /reasoningEfforts:\n {14}off: null\n {14}high: "high"/)
})

test('patchCordisText: openai-completions 补 compat.supportsReasoningEffort', async () => {
  const { patchCordisText } = await import('../lib/effort-config.js')
  const yaml = YAML_BASE.replace('api: openai-responses', 'api: openai-completions')
  const r = patchCordisText(yaml, 'omlx', 'Ornith-1.5-35B-A3B-BigBang-MTP-mlx-4bit')
  assert.ok(r.text)
  assert.match(r.text, / {12}compat:\n {14}supportsReasoningEffort: true\n {12}reasoningEfforts:\n {14}minimal: "none"/)
})

test('patchCordisText: 已有 compat 块时合并字段不建重复键', async () => {
  const { patchCordisText } = await import('../lib/effort-config.js')
  const yaml = YAML_BASE
    .replace('api: openai-responses', 'api: openai-completions')
    .replace(
      '            contextWindow: 131072\n            maxTokens: 16384\n            input:',
      '            contextWindow: 131072\n            maxTokens: 16384\n            compat:\n              supportsStore: false\n            input:',
    )
  const r = patchCordisText(yaml, 'omlx', 'Ornith-1.5-35B-A3B-BigBang-MTP-mlx-4bit')
  assert.ok(r.text)
  assert.equal((r.text.match(/compat:/g) || []).length, 1) // 只有一个 compat 键
  assert.match(r.text, /compat:\n {14}supportsStore: false\n {14}supportsReasoningEffort: true/)
})

test('patchCordisText: 不识别结构一律不写——provider/模型缺失、未知 api、无 llm-pi-ai 条目', async () => {
  const { patchCordisText } = await import('../lib/effort-config.js')
  assert.ok(patchCordisText(YAML_BASE, 'nosuch', 'm').reason)
  assert.ok(patchCordisText(YAML_BASE, 'omlx', 'nosuch-model').reason)
  assert.ok(patchCordisText('- id: other\n  config: {}\n', 'omlx', 'm').reason)
  const weird = YAML_BASE.replace('api: openai-responses', 'api: bedrock-converse')
  assert.match(patchCordisText(weird, 'omlx', 'Ornith-1.5-35B-A3B-BigBang-MTP-mlx-4bit').reason ?? '', /未识别/)
})

test('patchCordisText: 幂等——生成结果再喂一遍返回 exists', async () => {
  const { patchCordisText } = await import('../lib/effort-config.js')
  const r1 = patchCordisText(YAML_BASE, 'omlx', 'Ornith-1.5-35B-A3B-BigBang-MTP-mlx-4bit')
  const r2 = patchCordisText(r1.text, 'omlx', 'Ornith-1.5-35B-A3B-BigBang-MTP-mlx-4bit')
  assert.equal(r2.exists, true)
  assert.equal(r2.text, undefined)
})

test('ensureEffortConfig: 模型已报档位→has-efforts；非推理模型→no-reasoning；探测失败→probe-failed', async () => {
  const { ensureEffortConfig } = await import('../lib/effort-config.js')
  const route = { provider: 'p', model: 'm' }
  const mk = (reasoning) => ({
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    resolveModelInfo: async () => reasoning,
    stream: async function* () {
      yield { type: 'reasoning-delta', text: '想'.repeat(100) }
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  // 已声明档位：不发探测调用
  let r = await ensureEffortConfig(mk({ reasoning: { efforts: [{ id: 'minimal', name: 'm' }] } }), route)
  assert.equal(r.kind, 'has-efforts')
  // 非推理模型：探测调用无 reasoning → no-reasoning
  const quiet = mk(undefined)
  quiet.stream = async function* () {
    yield { type: 'text-delta', text: 'ok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  r = await ensureEffortConfig(quiet, route)
  assert.equal(r.kind, 'no-reasoning')
  // 推理模型但探测调用失败 → probe-failed（不写文件）
  const broken = mk(undefined)
  broken.stream = async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'connection refused', code: 'X' } } }
  }
  r = await ensureEffortConfig(broken, route)
  assert.equal(r.kind, 'probe-failed')
  // 探测不占用全局 LLM 槽位：挂起的 stream 靠自身 deadline 竞速退出（15s 太长——只看是否真绕过了 DshLlmClient）
})

test('ensureEffortConfig: 探测 stream 不走 DshLlmClient 信号量（旁路不堵真实调用）', async () => {
  const { ensureEffortConfig } = await import('../lib/effort-config.js')
  let sawRequest = false
  const llm = {
    resolveModelInfo: async () => undefined,
    stream: async function* (request) {
      sawRequest = true // 直连 stream（不是经 generateText/acquireLlmSlot 包装）
      await new Promise((resolve) => request.signal?.addEventListener('abort', resolve, { once: true }))
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'X' } } }
    },
  }
  // 挂起的端点：15s deadline 后 probe-failed 而非卡死——测试里不等满 15s，
  // 直接验证它确实走到了 stream 调用（signal 是探测自建的 AbortSignal.timeout）
  const p = ensureEffortConfig(llm, { provider: 'p', model: 'm' })
  await new Promise((r2) => setTimeout(r2, 50))
  assert.equal(sawRequest, true)
  // 15s 超时后才 settle——不等它，但要确认 promise 没提前 resolve
  let settled = false
  void p.then(() => { settled = true })
  await new Promise((r2) => setTimeout(r2, 100))
  assert.equal(settled, false)
})

test('cordisFiles: npm 布局下包自带 patch 先命中时 profile patch 仍被收集（回归：首个命中处早退 → profile 扫描死代码）', async () => {
  const { cordisFiles } = await import('../lib/effort-config.js')
  // 模拟 profiles/<p>/node_modules/<pkg>/lib/ 布局：包级 cordis.patch.yml 总在模块祖先
  const home = mkdtempSync(join(tmpdir(), 'effort-cordis-'))
  const pkgLib = join(home, 'profiles', 'desktop', 'node_modules', 'dsh-rss-news-daily', 'lib')
  mkdirSync(pkgLib, { recursive: true })
  writeFileSync(join(pkgLib, '..', 'cordis.patch.yml'), '- insert: []\n') // 包自带：无 llm-pi-ai
  writeFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), YAML_BASE) // profile 层：有 llm-pi-ai
  const other = join(home, 'profiles', 'aaa-other')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'cordis.patch.yml'), '# other profile\n')
  const files = await cordisFiles({ fromDir: pkgLib, dshHome: home })
  // 包文件 + 运行 profile + 其他 profile 全收集；运行 profile 先于扫描到的其他 profile（walk-up 在前）
  assert.deepEqual(files, [
    join(pkgLib, '..', 'cordis.patch.yml'),
    join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
    join(other, 'cordis.patch.yml'),
  ])
  // 端到端：遍历候选，含模型块的 profile patch 才是写入目标
  const { patchCordisText } = await import('../lib/effort-config.js')
  const { readFileSync } = await import('node:fs')
  const hit = files.map((f) => patchCordisText(readFileSync(f, 'utf8'), 'omlx', 'Ornith-1.5-35B-A3B-BigBang-MTP-mlx-4bit')).find((r) => r.text !== undefined)
  assert.ok(hit, 'expected some candidate to contain the model block')
})
