import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeBriefType, normalizeBriefTypes, builtinBriefType, resolveBriefTypes,
  briefScheduleText, briefsDirOf, briefFileOf, briefFileFor,
  briefDue, nextBriefMs, briefWindowStart, mergeBriefMarkdown,
} from '../lib/brief-types.js'

const DEF = { enabled: true, minScore: 7 }

// ---- normalizeBriefType ----

test('brief-type: normalize 正常字段透传+默认值', () => {
  const t = normalizeBriefType({ id: 'bt_1', name: '  AI 速递 ', schedule: { kind: 'daily', time: '8:05' } })
  assert.equal(t.name, 'AI 速递')
  assert.deepEqual(t.schedule, { kind: 'daily', time: '08:05' })
  assert.equal(t.enabled, true)
  assert.equal(t.minScore, 6) // 缺省 6
  assert.equal(t.maxItems, 0)
  assert.deepEqual(t.sourceIds, [])
})

test('brief-type: normalize 非法 id 整条丢弃', () => {
  assert.equal(normalizeBriefType({}), undefined)
  assert.equal(normalizeBriefType({ id: 'bad id!' }), undefined)
  assert.equal(normalizeBriefType(null), undefined)
})

test('brief-type: normalize schedule 畸形回退每 60 分钟；数值钳位', () => {
  assert.deepEqual(normalizeBriefType({ id: 'a', schedule: { kind: 'daily', time: '99:99' } }).schedule, { kind: 'minutes', everyMinutes: 60 })
  assert.deepEqual(normalizeBriefType({ id: 'a', schedule: { kind: 'minutes', everyMinutes: 1 } }).schedule, { kind: 'minutes', everyMinutes: 5 }) // 下限 5
  assert.deepEqual(normalizeBriefType({ id: 'a', schedule: { kind: 'hourly', minute: 99 } }).schedule, { kind: 'hourly', minute: 59 })
  assert.deepEqual(normalizeBriefType({ id: 'a' }).schedule, { kind: 'minutes', everyMinutes: 60 })
})

test('brief-type: normalizeBriefTypes 显式 [] 保持空（用户删光=真的没有类型）', () => {
  assert.deepEqual(normalizeBriefTypes([]), [])
  assert.equal(normalizeBriefTypes('x'), undefined)
  assert.equal(normalizeBriefTypes([{ id: 'ok' }, { id: 'bad id' }, {}]).length, 1)
})

// ---- resolveBriefTypes / 内置默认 ----

test('brief-type: 未配置→虚拟内置时段快报（旧设置合成种子，频率=每整点）', () => {
  const [t] = resolveBriefTypes({}, DEF)
  assert.equal(t.id, 'hourly')
  assert.equal(t.name, '时段快报')
  assert.equal(t.builtin, true)
  assert.equal(t.enabled, true)
  assert.deepEqual(t.schedule, { kind: 'hourly', minute: 0 })
  assert.equal(t.minScore, 7)
})

test('brief-type: 显式配置即按表返回；显式 [] = 无类型', () => {
  assert.equal(resolveBriefTypes({ briefTypes: [] }, DEF).length, 0)
  const [t] = resolveBriefTypes({ briefTypes: [{ id: 'mine', name: '自定义' }] }, DEF)
  assert.equal(t.id, 'mine')
  assert.equal(t.builtin, undefined)
})

test('brief-type: scheduleText 各频率文案', () => {
  assert.equal(briefScheduleText({ schedule: { kind: 'minutes', everyMinutes: 45 } }), '每 45 分钟')
  assert.equal(briefScheduleText({ schedule: { kind: 'hourly', minute: 15 } }), '每小时第 15 分')
  assert.equal(briefScheduleText({ schedule: { kind: 'daily', time: '08:30' } }), '每天 08:30')
})

// ---- 文件路径 ----

test('brief-type: 内置写 {day}-hourly.md，自定义写 briefs/{day}-{id}.md', () => {
  assert.equal(briefFileOf('/d', { id: 'hourly', builtin: true }, '2026-03-01'), '/d/2026-03-01-hourly.md')
  assert.equal(briefFileOf('/d', { id: 'bt_x' }, '2026-03-01'), '/d/briefs/2026-03-01-bt_x.md')
  assert.equal(briefFileFor('/d', 'hourly', '2026-03-01'), '/d/2026-03-01-hourly.md')
  assert.equal(briefFileFor('/d', 'bt_gone', '2026-03-01'), '/d/briefs/2026-03-01-bt_gone.md') // 已删类型历史文件仍可读
  assert.equal(briefsDirOf('/d'), '/d/briefs')
})

// ---- 槽位调度 ----

const T = (schedule) => ({ id: 'x', name: 'x', enabled: true, schedule, sourceIds: [], keywords: [], minScore: 0, maxItems: 0, focus: '' })

test('brief-type: minutes——距 lastRun ≥ everyMinutes 到期；从未跑过立即到期', () => {
  const t = T({ kind: 'minutes', everyMinutes: 30 })
  const now = new Date('2026-03-01T10:00:00Z')
  assert.equal(briefDue(t, undefined, now), true)
  assert.equal(briefDue(t, '2026-03-01T09:45:00Z', now), false)
  assert.equal(briefDue(t, '2026-03-01T09:29:00Z', now), true)
  assert.equal(nextBriefMs(t, '2026-03-01T09:45:00Z', now), 15 * 60_000)
  assert.equal(nextBriefMs(t, undefined, now), 0)
})

test('brief-type: hourly——每个 :MM 槽；lastRun 覆盖本槽即未到期', () => {
  const t = T({ kind: 'hourly', minute: 10 })
  const now = new Date('2026-03-01T10:30:00Z') // 本槽 10:10 已到达（显式 UTC——本机时区不假设）
  assert.equal(briefDue(t, undefined, now, 'UTC'), true)
  assert.equal(briefDue(t, '2026-03-01T10:10:00Z', now, 'UTC'), false) // 覆盖本槽
  assert.equal(briefDue(t, '2026-03-01T09:50:00Z', now, 'UTC'), true)  // 只覆盖上槽
  // 下一槽 11:10
  assert.equal(nextBriefMs(t, '2026-03-01T10:10:00Z', now, 'UTC'), 40 * 60_000)
  const early = new Date('2026-03-01T10:05:00Z') // 本槽 10:10 还没到→上槽是 09:10
  assert.equal(briefDue(t, '2026-03-01T09:10:00Z', early, 'UTC'), false)
})

test('brief-type: daily——今日 HH:mm 槽；当日错过→首次到达即补', () => {
  const t = T({ kind: 'daily', time: '08:00' })
  const after = new Date('2026-03-01T10:00:00Z')
  assert.equal(briefDue(t, undefined, after, 'UTC'), true)
  assert.equal(briefDue(t, '2026-03-01T08:00:00Z', after, 'UTC'), false)
  assert.equal(briefDue(t, '2026-02-28T08:00:00Z', after, 'UTC'), true) // 昨日槽不顶今日
  const before = new Date('2026-03-01T06:00:00Z')
  assert.equal(briefDue(t, '2026-02-28T08:00:00Z', before, 'UTC'), false) // 今日槽未到→昨日槽已覆盖
  // 跨日不补历史槽：停了三天重启，只有今日槽会触发（briefDue 只看最近槽）
  const threeDaysLater = new Date('2026-03-04T10:00:00Z')
  assert.equal(briefDue(t, '2026-03-01T08:00:00Z', threeDaysLater, 'UTC'), true)
  assert.equal(briefDue(t, '2026-03-04T08:00:00Z', threeDaysLater, 'UTC'), false)
})

test('brief-type: 窗口起点——有 lastRun 取 max(lastRun,今日0点)；首跑覆盖全天', () => {
  const dayStart = '2026-03-01T00:00:00Z'
  assert.equal(briefWindowStart(undefined, dayStart), dayStart)
  assert.equal(briefWindowStart('2026-02-28T22:00:00Z', dayStart), dayStart) // 昨日 lastRun 不顶事
  assert.equal(briefWindowStart('2026-03-01T09:30:00Z', dayStart), '2026-03-01T09:30:00Z')
})

// ---- 合并视图 ----

test('brief-type: mergeBriefMarkdown 按 HH:mm 倒序拼接各类型节', () => {
  const hourly = '# 时段快报 · 2026-03-01\n\n## 09:00 时段快报\n\n- 旧条目A\n\n## 11:00 时段快报\n\n- 条目B\n'
  const custom = '# AI 速递 · 2026-03-01\n\n## 10:30 AI 速递\n\n- 条目C\n'
  const md = mergeBriefMarkdown('2026-03-01', [hourly, custom])
  assert.match(md, /^# 今日快报 · 2026-03-01/)
  const order = [...md.matchAll(/^## (\d{2}:\d{2})/gm)].map((m) => m[1])
  assert.deepEqual(order, ['11:00', '10:30', '09:00'])
  assert.match(md, /条目A/) && assert.match(md, /条目C/)
})

test('brief-type: mergeBriefMarkdown 无节→undefined；非时段节忽略', () => {
  assert.equal(mergeBriefMarkdown('2026-03-01', []), undefined)
  assert.equal(mergeBriefMarkdown('2026-03-01', ['# 头\n\n## 概述\n\nx']), undefined) // ## 后非 HH:mm 不并入
  const md = mergeBriefMarkdown('2026-03-01', ['# 头\n\n前言\n\n## 12:00 X\n\n- e\n\n## 备注\n\ny'])
  assert.equal([...md.matchAll(/^## /gm)].length, 1)
})

// ---- API 层：/brief-types CRUD + /briefs 读取 + /brief-run（m4 挂载模式） ----

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mkRes = () => ({ statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b ?? '' } })
const mkReq = (method, url, body) => ({
  method, url, headers: {},
  on(ev, cb) { if (ev === 'end') setImmediate(cb); if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body))) },
})
const findH = (regs, path, kind = 'exact') => regs.find((r) => r.path === path && r.kind === kind)?.handler

const mkBriefDeps = async () => {
  const { Store } = await import('../lib/core/store.js')
  const { PrefsStore } = await import('../lib/core/prefs.js')
  const store = new Store({ path: join(mkdtempSync(join(tmpdir(), 'rnd-bts-')), 's.json') })
  await store.load()
  const prefs = new PrefsStore(join(mkdtempSync(join(tmpdir(), 'rnd-btp-')), 'p.json'))
  const digestsDir = mkdtempSync(join(tmpdir(), 'rnd-btd-'))
  const ran = []
  const svc = {
    listSources: () => [],
    runBriefNow: (sel, opts) => { ran.push({ sel, opts }); return { ok: true, started: true } },
  }
  return {
    store, prefs, svc, configSources: [], timezone: 'UTC', readerPageSize: 50,
    digestsDir, runDigest: async () => {},
    briefDefaults: { enabled: true, minScore: 6 },
    _ran: ran,
  }
}

test('api: /brief-types GET 未配置返回内置时段快报；POST 新增固化全表', async () => {
  const { mountApi } = await import('../lib/api.js')
  const deps = await mkBriefDeps()
  const regs = []
  mountApi({ register: (o) => { regs.push(o); return () => {} } }, deps)

  const exact = findH(regs, '/dsh-rss-news-daily/api/brief-types')
  const prefix = findH(regs, '/dsh-rss-news-daily/api/brief-types', 'prefix')
  assert.ok(exact && prefix)

  let res = mkRes()
  await exact(mkReq('GET', '/dsh-rss-news-daily/api/brief-types'), res)
  let out = JSON.parse(res.body)
  assert.equal(out.types.length, 1)
  assert.equal(out.types[0].id, 'hourly')
  assert.equal(out.types[0].scheduleText, '每小时第 0 分')

  res = mkRes()
  await exact(mkReq('POST', '/dsh-rss-news-daily/api/brief-types', { name: 'AI 速递', schedule: { kind: 'hourly', minute: 15 }, minScore: 7, maxItems: 20, keywords: ['大模型'], focus: '只看发布' }), res)
  out = JSON.parse(res.body)
  assert.equal(out.ok, true)
  assert.match(out.type.id, /^bt_/)
  // 固化：prefs.briefTypes 现在两条（内置被一并写入）
  assert.equal(deps.prefs.get().briefTypes.length, 2)

  // PATCH 改名+停用
  res = mkRes()
  await prefix(mkReq('PATCH', `/dsh-rss-news-daily/api/brief-types/${out.type.id}`, { enabled: false, minScore: 8 }), res)
  const patched = JSON.parse(res.body)
  assert.equal(patched.type.enabled, false)
  assert.equal(patched.type.minScore, 8)

  // DELETE 删掉自定义，剩内置
  res = mkRes()
  await prefix(mkReq('DELETE', `/dsh-rss-news-daily/api/brief-types/${patched.type.id}`), res)
  assert.equal(JSON.parse(res.body).ok, true)
  assert.equal(deps.prefs.get().briefTypes.length, 1)

  // POST 空名 → 400
  res = mkRes()
  await exact(mkReq('POST', '/dsh-rss-news-daily/api/brief-types', { name: '  ' }), res)
  assert.equal(res.statusCode, 400)
})

test('api: /briefs all=合并视图按节倒序；type=<id>=单类型直读；已删类型文件仍可读', async () => {
  const { mountApi } = await import('../lib/api.js')
  const deps = await mkBriefDeps()
  const regs = []
  mountApi({ register: (o) => { regs.push(o); return () => {} } }, deps)

  const day = '2026-03-01'
  writeFileSync(join(deps.digestsDir, `${day}-hourly.md`), '# 时段快报\n\n## 09:00 时段快报\n\n- a\n')
  mkdirSync(join(deps.digestsDir, 'briefs'))
  writeFileSync(join(deps.digestsDir, 'briefs', `${day}-bt_x.md`), '# AI 速递\n\n## 10:30 AI 速递\n\n- b\n')

  const h = findH(regs, '/dsh-rss-news-daily/api/briefs')
  let res = mkRes()
  await h(mkReq('GET', `/dsh-rss-news-daily/api/briefs?day=${day}&type=all`), res)
  let out = JSON.parse(res.body)
  const order = [...out.markdown.matchAll(/^## (\d{2}:\d{2})/gm)].map((m) => m[1])
  assert.deepEqual(order, ['10:30', '09:00'])

  res = mkRes()
  await h(mkReq('GET', `/dsh-rss-news-daily/api/briefs?day=${day}&type=bt_x`), res)
  out = JSON.parse(res.body)
  assert.match(out.markdown, /## 10:30 AI 速递/)

  res = mkRes()
  await h(mkReq('GET', `/dsh-rss-news-daily/api/briefs?day=${day}&type=hourly`), res)
  assert.match(JSON.parse(res.body).markdown, /## 09:00 时段快报/)

  res = mkRes()
  await h(mkReq('GET', `/dsh-rss-news-daily/api/briefs?day=1999-01-01&type=all`), res)
  assert.equal(res.statusCode, 404)
})

test('api: /brief-run 透传 type/holdInPeak/peakBypass 给 svc.runBriefNow', async () => {
  const { mountApi } = await import('../lib/api.js')
  const deps = await mkBriefDeps()
  const regs = []
  mountApi({ register: (o) => { regs.push(o); return () => {} } }, deps)
  const h = findH(regs, '/dsh-rss-news-daily/api/brief-run')
  const res = mkRes()
  await h(mkReq('POST', '/dsh-rss-news-daily/api/brief-run', { type: 'bt_ai', holdInPeak: true, peakBypass: false }), res)
  const out = JSON.parse(res.body)
  assert.equal(out.ok, true)
  assert.deepEqual(deps._ran[0], { sel: 'bt_ai', opts: { holdInPeak: true, peakBypass: false } })
})
