import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const {
  compareSemver, companionVersions, findProfileDeps, scanProfileDeps, listCompanions,
  sanitizeUpdateInfo, runUpdateCheck, startUpdateCheck, reportToken,
} = await import('../lib/update-check.js')

const noopLog = { info() {}, warn() {}, error() {} }
const SELF = 'dsh-rss-news-daily'

// ---------- compareSemver ----------
test('compareSemver: 三段比较', () => {
  assert.equal(compareSemver('1.2.0', '1.2.0'), 0)
  assert.equal(compareSemver('1.2.0', '1.3.0'), -1)
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1)
  assert.equal(compareSemver('1.2.1', '1.2.0'), 1)
})
test('compareSemver: 预发版 < 同号正式版；不可解析返回 0', () => {
  assert.equal(compareSemver('1.3.0-rc.1', '1.3.0'), -1)
  assert.equal(compareSemver('1.3.0', '1.3.0-rc.1'), 1)
  assert.equal(compareSemver('v1.2.0', '1.2.0'), 0)
  assert.equal(compareSemver('garbage', '1.2.0'), 0)
  assert.equal(compareSemver('1.2', '1.2.0'), 0)
})

// ---------- companionVersions ----------
test('companionVersions: 前缀筛选 + 排除自身 + 去范围符 + file: 还原', () => {
  const deps = {
    'dsh-rss-news-daily': '1.2.0',
    'dsh-rss-news-zhuikan': '0.2.0',
    'dsh-rss-news-flash-kuaixun': '^0.2.0',
    'dsh-rss-news-browser-fetch': 'file:../bf',
    'dshmarket': '1.73.20',        // 非前缀不入选
    'dsh-unlag': '1.17.8',
  }
  const got = companionVersions(deps, SELF, (spec) => spec === 'file:../bf' ? '0.2.1' : undefined)
  assert.deepEqual(got, {
    'dsh-rss-news-zhuikan': '0.2.0',
    'dsh-rss-news-flash-kuaixun': '0.2.0',
    'dsh-rss-news-browser-fetch': '0.2.1',
  })
})
test('companionVersions: file: 还原失败如实报字面量', () => {
  const got = companionVersions({ 'dsh-rss-news-x': 'file:/nonexistent' }, SELF, () => undefined)
  assert.equal(got['dsh-rss-news-x'], 'file:/nonexistent')
})

// ---------- manifest 定位 ----------
const mkProfile = (root, { selfInBundles = true, deps = {} } = {}) => {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test', dependencies: deps,
    dsh: { profile: { bundles: selfInBundles ? [SELF, 'other'] : ['other'] } },
  }))
}

test('findProfileDeps: 从 node_modules/self/lib 向上命中 profile 清单', () => {
  const base = mkdtempSync(join(tmpdir(), 'rnd-prof-'))
  mkProfile(base, { deps: { [SELF]: '1.2.0', 'dsh-rss-news-zhuikan': '0.2.0' } })
  const libDir = join(base, 'node_modules', SELF, 'lib')
  mkdirSync(libDir, { recursive: true })
  const hit = findProfileDeps(libDir, SELF)
  assert.equal(hit.dir, base)
  assert.equal(hit.deps['dsh-rss-news-zhuikan'], '0.2.0')
})
test('findProfileDeps: bundles 不含自身 / 无 dsh.profile → 跳过', () => {
  const base = mkdtempSync(join(tmpdir(), 'rnd-prof-'))
  mkProfile(base, { selfInBundles: false })
  const sub = join(base, 'a', 'b'); mkdirSync(sub, { recursive: true })
  assert.equal(findProfileDeps(sub, SELF), undefined)
})
test('scanProfileDeps: 扫 profiles 目录取首个 bundles 含自身的（名字序）', () => {
  const home = mkdtempSync(join(tmpdir(), 'rnd-home-'))
  mkProfile(join(home, 'profiles', 'web'), { selfInBundles: false })
  mkProfile(join(home, 'profiles', 'desktop'), { deps: { [SELF]: '1.2.0' } })
  const hit = scanProfileDeps(home, SELF)
  assert.equal(hit.dir, join(home, 'profiles', 'desktop'))
})
test('listCompanions: 端到端——walk-up + file: 跟随真实版本', () => {
  const base = mkdtempSync(join(tmpdir(), 'rnd-prof-'))
  const bfDir = join(base, 'vendor', 'bf'); mkdirSync(bfDir, { recursive: true })
  writeFileSync(join(bfDir, 'package.json'), JSON.stringify({ name: 'dsh-rss-news-browser-fetch', version: '9.9.9' }))
  mkProfile(base, { deps: { [SELF]: '1.2.0', 'dsh-rss-news-browser-fetch': 'file:vendor/bf', 'dsh-rss-news-zhuikan': '0.2.0' } })
  const libDir = join(base, 'node_modules', SELF, 'lib'); mkdirSync(libDir, { recursive: true })
  const got = listCompanions(SELF, { fromDir: libDir })
  assert.deepEqual(got, { 'dsh-rss-news-browser-fetch': '9.9.9', 'dsh-rss-news-zhuikan': '0.2.0' })
})

// ---------- sanitizeUpdateInfo ----------
test('sanitizeUpdateInfo: 合法响应通过，坏字段剥除', () => {
  assert.deepEqual(sanitizeUpdateInfo({ latest: '1.3.0', url: 'https://x/r', notes: 'n' }),
    { latest: '1.3.0', url: 'https://x/r', notes: 'n' })
  assert.deepEqual(sanitizeUpdateInfo({ latest: '1.3.0', url: 'javascript:alert(1)' }), { latest: '1.3.0' })
  assert.equal(sanitizeUpdateInfo({ url: 'https://x' }), null)        // latest 缺失
  assert.equal(sanitizeUpdateInfo('not object'), null)
  assert.equal(sanitizeUpdateInfo({ latest: 'abc' }), null)           // latest 不像版本号
  const c = sanitizeUpdateInfo({ latest: '1.3.0', companions: { 'dsh-rss-news-zhuikan': { latest: '0.3.0' }, bad: { nope: 1 } } })
  assert.deepEqual(c.companions, { 'dsh-rss-news-zhuikan': { latest: '0.3.0' } })
})

// ---------- runUpdateCheck ----------
const okFetch = (body) => async () => ({ ok: true, text: async () => JSON.stringify(body) })
test('runUpdateCheck: 成功解析；非 https 端点拒跑', async () => {
  const info = await runUpdateCheck({ endpoint: 'https://u/v1/check', timeoutMs: 5000, report: { pkg: SELF, version: '1.2.0', companions: {} }, fetchImpl: okFetch({ latest: '1.3.0' }), log: noopLog })
  assert.equal(info.latest, '1.3.0')
  assert.equal(await runUpdateCheck({ endpoint: 'http://u/v1/check', timeoutMs: 5000, report: { pkg: SELF, version: '1.2.0', companions: {} }, fetchImpl: okFetch({}), log: noopLog }), null)
})
test('runUpdateCheck: 上报字段编码进 GET query（nginx 日志管线）', async () => {
  let hit = ''
  const spy = async (url) => { hit = String(url); return { ok: true, text: async () => '{"latest":"1.2.0"}' } }
  await runUpdateCheck({ endpoint: 'https://u/v1/check', timeoutMs: 5000, report: { pkg: SELF, version: '1.2.0', companions: { 'dsh-rss-news-zhuikan': '0.2.0' } }, fetchImpl: spy, log: noopLog })
  const u = new URL(hit)
  assert.equal(u.searchParams.get('pkg'), SELF)
  assert.equal(u.searchParams.get('version'), '1.2.0')
  assert.deepEqual(JSON.parse(u.searchParams.get('companions')), { 'dsh-rss-news-zhuikan': '0.2.0' })
})
test('runUpdateCheck: installId+day → iid/d/t 签名三参且服务端可复算', async () => {
  let hit = ''
  const spy = async (url) => { hit = String(url); return { ok: true, text: async () => '{"latest":"1.2.0"}' } }
  const comp = { 'dsh-rss-news-zhuikan': '0.2.0' }
  await runUpdateCheck({ endpoint: 'https://u/v1/check', timeoutMs: 5000, report: { pkg: SELF, version: '1.2.0', companions: comp }, installId: 'iid-1', day: '2026-11-19', fetchImpl: spy, log: noopLog })
  const u = new URL(hit)
  assert.equal(u.searchParams.get('iid'), 'iid-1')
  assert.equal(u.searchParams.get('d'), '2026-11-19')
  assert.equal(u.searchParams.get('t'), reportToken({ iid: 'iid-1', day: '2026-11-19', pkg: SELF, version: '1.2.0', companionsJson: JSON.stringify(comp) }))
  // 未给 installId 的旧行为：不带签名参数
  hit = ''
  await runUpdateCheck({ endpoint: 'https://u/v1/check', timeoutMs: 5000, report: { pkg: SELF, version: '1.2.0', companions: {} }, fetchImpl: spy, log: noopLog })
  assert.equal(new URL(hit).searchParams.get('t'), null)
})
test('reportToken: 格式 v1.<16hex>，字段变动签名变', () => {
  const base = { iid: 'i', day: '2026-11-19', pkg: SELF, version: '1.2.0', companionsJson: '' }
  const t = reportToken(base)
  assert.match(t, /^v1\.[0-9a-f]{16}$/)
  assert.notEqual(reportToken({ ...base, version: '1.3.0' }), t)
})
test('runUpdateCheck: HTTP 错/异常/超大体 → null', async () => {
  const rep = { pkg: SELF, version: '1.2.0', companions: {} }
  assert.equal(await runUpdateCheck({ endpoint: 'https://u', timeoutMs: 5000, report: rep, fetchImpl: async () => ({ ok: false, status: 500 }), log: noopLog }), null)
  assert.equal(await runUpdateCheck({ endpoint: 'https://u', timeoutMs: 5000, report: rep, fetchImpl: async () => { throw new Error('net') }, log: noopLog }), null)
  assert.equal(await runUpdateCheck({ endpoint: 'https://u', timeoutMs: 5000, report: rep, fetchImpl: async () => ({ ok: true, text: async () => 'x'.repeat(20 * 1024) }), log: noopLog }), null)
})

// ---------- startUpdateCheck：一天一次闸（挂在当日第一次抓取上调用） ----------
const mkOpts = (over = {}) => ({
  enabled: () => true, endpoint: () => 'https://u/v1/check', timeoutMs: 5000,
  selfPkg: SELF, selfVer: '1.2.0', companions: () => ({ 'dsh-rss-news-zhuikan': '0.2.0' }),
  meta: () => mkOpts._meta, save: () => { mkOpts._saves++ }, log: noopLog, ...over,
})

test('startUpdateCheck: 成功写 meta + hasUpdate + onUpdate；同日二次触发不再请求', async () => {
  mkOpts._meta = {}; mkOpts._saves = 0
  let fetches = 0, updates = 0
  const fetchImpl = async () => { fetches++; return { ok: true, text: async () => JSON.stringify({ latest: '1.3.0', url: 'https://x' }) } }
  const check = startUpdateCheck(mkOpts({ fetchImpl, onUpdate: () => updates++ }))
  await check() // 当日第一次抓取触发：发请求
  assert.equal(fetches, 1)
  assert.equal(mkOpts._meta.updateCheck.hasUpdate, true)
  assert.equal(mkOpts._meta.updateCheck.latest, '1.3.0')
  assert.equal(updates, 1)
  await check() // 同日第二次：闸住
  assert.equal(fetches, 1)
})
test('startUpdateCheck: 失败也记 lastAttemptDay（当天不再重试）；无更新不回调', async () => {
  mkOpts._meta = {}; mkOpts._saves = 0
  let fetches = 0, updates = 0
  const fetchImpl = async () => { fetches++; throw new Error('down') }
  const check = startUpdateCheck(mkOpts({ fetchImpl, onUpdate: () => updates++ }))
  await check()
  assert.equal(fetches, 1)
  assert.equal(mkOpts._meta.updateCheck.lastAttemptDay.length, 10) // YYYY-MM-DD
  assert.equal(mkOpts._meta.updateCheck.hasUpdate, undefined)
  assert.equal(updates, 0)
  await check()
  assert.equal(fetches, 1)
})
test('startUpdateCheck: disabled 不记台账不发请求', async () => {
  mkOpts._meta = {}; mkOpts._saves = 0
  let fetches = 0
  const check = startUpdateCheck(mkOpts({ enabled: () => false, fetchImpl: async () => { fetches++ } }))
  await check()
  assert.equal(fetches, 0)
  assert.equal(mkOpts._meta.updateCheck, undefined)
})
