import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const noopLog = { info() {}, warn() {}, error() {} }

/** 记录 spawn 调用的假 spawn：on('error') 返回自身、unref 记录 */
const mkSpawn = () => {
  const calls = []
  const spawn = (cmd, args, opts) => {
    const p = {
      calls, cmd, args, opts, unrefed: false,
      on(ev, cb) { return this },
      unref() { this.unrefed = true },
    }
    calls.push(p)
    return p
  }
  spawn.calls = calls
  return spawn
}

const mkItem = (id, over = {}) => ({
  id: `i${id}`, title: `news ${id}`, link: `https://x/${id}`, summary: `s${id}`,
  topic: '科技', sourceId: 'src1', publishedAt: new Date(Date.now() - 3600e3).toISOString(), fetchedAt: new Date().toISOString(),
  hash: `h${id}`, digestedDay: '', score: 0, reasons: [], state: { read: false, hidden: false, liked: 0 }, ...over,
})
const mkClient = (handler) => ({ generateText: async (req) => handler(req) })

test('notify: prefs.notifyDesktop 只在显式 true 时保留', async () => {
  const { normalizePrefs } = await import('../lib/core/prefs.js')
  assert.equal(normalizePrefs({ notifyDesktop: true }).notifyDesktop, true)
  assert.equal(normalizePrefs({ notifyDesktop: false }).notifyDesktop, undefined)
  assert.equal(normalizePrefs({}).notifyDesktop, undefined)
  assert.equal(normalizePrefs({ notifyDesktop: 'yes' }).notifyDesktop, undefined)
})

test('notify: darwin 有 helper 走 helper，带点击 URL 与接力标记', async () => {
  const { desktopNotify } = await import('../lib/notify.js')
  const dir = mkdtempSync(join(tmpdir(), 'rnd-nt-'))
  const bin = join(dir, 'fake-helper')
  writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
  const spawn = mkSpawn()
  desktopNotify('标题', '正文', { url: 'dsh://open', flagFile: '/tmp/pv.json' }, { spawn, platform: 'darwin', helperBin: bin })
  assert.equal(spawn.calls.length, 1)
  assert.equal(spawn.calls[0].cmd, bin)
  assert.deepEqual(spawn.calls[0].args, ['标题', '正文', 'dsh://open', '/tmp/pv.json'])
  assert.equal(spawn.calls[0].opts.detached, true)
  assert.equal(spawn.calls[0].unrefed, true)
})

test('notify: darwin 无 helper 降级 osascript，spawn 抛错被吞', async () => {
  const { desktopNotify } = await import('../lib/notify.js')
  const spawn = mkSpawn()
  desktopNotify('标题"a"', '正文', {}, { spawn, platform: 'darwin', helperBin: '/nonexistent/RndNotify' })
  assert.equal(spawn.calls[0].cmd, 'osascript')
  assert.match(spawn.calls[0].args[1], /display notification "正文" with title "标题\\"a\\""/)
  // spawn 同步抛错（如 EACCES）不得漏出
  const badSpawn = () => { throw new Error('EACCES') }
  assert.doesNotThrow(() => desktopNotify('t', 'b', {}, { spawn: badSpawn, platform: 'darwin', helperBin: '/nonexistent/x' }))
})

test('notify: linux→notify-send / win32→powershell toast', async () => {
  const { desktopNotify } = await import('../lib/notify.js')
  let spawn = mkSpawn()
  desktopNotify('T', 'B', { url: 'http://x' }, { spawn, platform: 'linux' })
  assert.equal(spawn.calls[0].cmd, 'notify-send')
  assert.deepEqual(spawn.calls[0].args, ['T', 'B'])
  spawn = mkSpawn()
  desktopNotify('T', "B'q", {}, { spawn, platform: 'win32' })
  assert.equal(spawn.calls[0].cmd, 'powershell')
  assert.match(spawn.calls[0].args.join(' '), /B''q/) // 单引号按 PS 规则翻倍
})

test('notify: onBrief 在实段写入后带摘要与条数回调，空时段不触发', async () => {
  const { appendHourlyBrief } = await import('../lib/digest-pipeline.js')
  const dir = mkdtempSync(join(tmpdir(), 'rnd-ob-'))
  const items = [mkItem(1, { llmScore: 8 })]
  const got = []
  const n = await appendHourlyBrief({
    items, sourcesById: new Map([['src1', { title: 'Src1' }]]),
    day: '2026-11-10', time: '11:00', minScore: 6, digestsDir: dir,
    llmClient: mkClient(() => 'AI 领域本时段要点。'),
    onBrief: (brief, count) => got.push([brief, count]),
    log: noopLog,
  })
  assert.equal(n, 1)
  assert.deepEqual(got, [['AI 领域本时段要点。', 1]])

  // 空时段只写说明行，不触发 onBrief
  const n2 = await appendHourlyBrief({
    items: [], sourcesById: new Map(), day: '2026-11-10', time: '12:00',
    minScore: 6, digestsDir: dir, onBrief: (b, c) => got.push([b, c]), log: noopLog,
  })
  assert.equal(n2, 0)
  assert.equal(got.length, 1)

  // onBrief 抛错不得影响写盘结果
  const n3 = await appendHourlyBrief({
    items: [mkItem(2, { llmScore: 9 })], sourcesById: new Map(), day: '2026-11-10', time: '13:00',
    minScore: 6, digestsDir: dir, onBrief: () => { throw new Error('boom') }, log: noopLog,
  })
  assert.equal(n3, 1)
})
