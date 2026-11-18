/** 审计修复回归（2026-11）：XSS 属性注入、zip 炸弹、ReDoS、路径穿越、同源收紧、去重等价性。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

const core = '../lib/core/'

// ---- 1. parser 属性扫描：ReDoS 消除 + 语义保持 ----

test('audit: parseTag 恶意长 tag 线性完成（原正则 O(n²) 回溯）', async () => {
  const { parseFeedDocument } = await import(core + 'parser.js')
  // 400KB 无 `=` 的交替 token——旧实现在此输入上分钟级停摆
  const hostile = 'x '.repeat(200_000)
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item ${hostile}><title>A</title><guid>a</guid></item></channel></rss>`
  const t0 = performance.now()
  const feed = parseFeedDocument(xml)
  const ms = performance.now() - t0
  assert.equal(feed.items.length, 1, 'hostile attrs must not break item parsing')
  assert.ok(ms < 2000, `parse took ${Math.round(ms)}ms — attr scan must be linear`)
})

test('audit: parseTag 属性语义与原实现一致（引号含>/空格环绕=/实体）', async () => {
  const { parseXml } = await import(core + 'parser.js')
  const el = parseXml('<a href="http://x/a>b" title=\'单引\' data-x = " spaced " label="A&amp;B" plain=v1/>')
  assert.equal(el.attributes.href, 'http://x/a>b', 'quoted value keeps >')
  assert.equal(el.attributes.title, '单引')
  assert.equal(el.attributes['data-x'], ' spaced ', 'whitespace around = tolerated (in-quote spaces preserved as value, same as original regex)')
  assert.equal(el.attributes.label, 'A&B', 'entities decoded')
  assert.equal(el.attributes.plain, 'v1', 'unquoted value')
  // 无 = 的裸 token 不产属性；attr 名后的怪字符不死循环
  const weird = parseXml('<b =bad disabled ok=1/>')
  assert.equal(weird.attributes.ok, '1')
  assert.equal(weird.attributes.disabled, undefined)
})

// ---- 2. zip 解压配额：炸弹拦截 ----

/** 手工 zip：单条目 deflate 压缩流 + 中央目录 + EOCD（可注入解压配额） */
function craftZip(entries) {
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunks = []; const central = []; let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const payload = deflateRawSync(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(e.data), 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10)
    cen.writeUInt32LE(crc32(e.data), 16); cen.writeUInt32LE(payload.length, 20); cen.writeUInt32LE(e.data.length, 24)
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42)
    chunks.push(local, name, payload)
    central.push(Buffer.concat([cen, name]))
    offset += 30 + name.length + payload.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cd, eocd])
}

test('audit: unzipEntries 单条目解压超限拒绝（zip 炸弹）', async () => {
  const { unzipEntries } = await import(core + 'zip.js')
  const bomb = craftZip([{ name: 'store.db', data: Buffer.alloc(1024 * 1024, 0) }]) // 1MB→deflate 极小
  assert.throws(() => unzipEntries(bomb, { entry: 64 * 1024 }), /larger than/i, 'inflate over entry cap must throw')
  const ok = unzipEntries(bomb, { entry: 2 * 1024 * 1024 })
  assert.equal(ok[0].data.length, 1024 * 1024, 'under cap inflates fully')
})

test('audit: unzipEntries 全包总量超限拒绝', async () => {
  const { unzipEntries } = await import(core + 'zip.js')
  const zip = craftZip([
    { name: 'a', data: Buffer.alloc(600 * 1024, 0) },
    { name: 'b', data: Buffer.alloc(600 * 1024, 0) },
  ])
  assert.throws(() => unzipEntries(zip, { entry: 1024 * 1024, total: 1024 * 1024 }), /总量/)
})

// ---- 3. NDJSON 导入 day 穿越 ----

test('audit: importNdjson 恶意 day 不落盘穿越路径', async () => {
  const { SqliteStore } = await import(core + 'sqlite-store.js')
  const dir = mkdtempSync(join(tmpdir(), 'rnd-audit-imp-'))
  const st = new SqliteStore({ path: join(dir, 'store.db') })
  await st.load()
  const digestsDir = join(dir, 'digests')
  const file = join(dir, 'evil.ndjson')
  writeFileSync(file, [
    JSON.stringify({ type: 'digest', day: '../escape', data: 'EVIL' }),
    JSON.stringify({ type: 'digest', day: '2026-11-18', kind: 'hourly', data: 'GOOD' }),
    '',
  ].join('\n'))
  const counts = await st.importNdjson(file, digestsDir)
  assert.equal(counts.digests, 1, 'only the well-formed day line imports')
  assert.equal(readFileSync(join(digestsDir, '2026-11-18-hourly.md'), 'utf8'), 'GOOD')
  assert.equal(existsSync(join(dir, 'escape-rss-briefing.md')), false, 'no traversal write')
  assert.equal(existsSync(join(digestsDir, '../escape-rss-briefing.md')), false)
})

// ---- 4. briefFileFor 消毒 ----

test('audit: briefFileFor 剥离 typeKey 中的路径字符', async () => {
  const { briefFileFor } = await import('../lib/brief-types.js')
  const out = briefFileFor('/data/digests', '../../../etc/passwd', '2026-01-02')
  assert.ok(!out.includes('..'), `must not traverse: ${out}`)
  assert.ok(out.endsWith('2026-01-02-etcpasswd.md'), out)
  assert.equal(briefFileFor('/d', 'hourly', '2026-01-02'), '/d/2026-01-02-hourly.md')
})

// ---- 5. dedupeStories 倒排索引与全量对比等价 ----

test('audit: dedupeStories 倒排候选与全量两两对比结果完全一致', async () => {
  const { dedupeStories } = await import('../lib/digest-pipeline.js')
  // 参考实现：旧版 O(n²) 全量对比（语义基准）
  const reference = (items) => {
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const toks = (s) => {
      const n = norm(s).replace(/([a-z0-9])([\u4e00-\u9fff])/g, '$1 $2').replace(/([\u4e00-\u9fff])([a-z0-9])/g, '$1 $2')
      const set = new Set()
      for (const w of n.split(' ').filter(Boolean)) {
        if (/[\u4e00-\u9fff]/.test(w)) for (let i = 0; i + 1 < w.length; i++) set.add(w.slice(i, i + 2))
        else set.add(w)
      }
      return set
    }
    const out = []; const tokSets = []
    for (const it of items) {
      const ts = toks(it.title)
      if (ts.size === 0) { out.push(it); tokSets.push(ts); continue }
      let hit = -1
      for (let j = 0; j < out.length; j++) {
        const inter = [...ts].filter((w) => tokSets[j].has(w)).length
        if (inter / (ts.size + tokSets[j].size - inter) > 0.55) { hit = j; break }
      }
      if (hit >= 0) { out[hit].dupCount = (out[hit].dupCount || 0) + 1; it.dupOf = out[hit].id }
      else { out.push(it); tokSets.push(ts) }
    }
    return out
  }
  const mk = (id, title) => ({ id, title, dupCount: 0, dupOf: undefined })
  let seed = 20261118
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
  const words = ['OpenAI', 'releases', 'GPT-6', 'model', '微软', '发布', '新模型', 'AI', '芯片', 'news', 'item', '苹果', '更新', '系统']
  const corpus = []
  for (let i = 0; i < 300; i++) {
    const base = words.filter(() => rnd() > 0.55)
    const t = base.length ? base.join(' ') : `solo ${i}`
    // 40% 概率同题变体：保证真实命中簇出现
    corpus.push(mk(`i${i}`, rnd() > 0.4 ? t : `${t} today`))
  }
  corpus.push(mk('e1', ''), mk('e2', '   '), mk('n1', 'News item 1'), mk('n2', 'News item 2'))
  const a = dedupeStories(structuredClone(corpus))
  const b = reference(structuredClone(corpus))
  assert.deepEqual(a.map((x) => [x.id, x.dupOf, x.dupCount]), b.map((x) => [x.id, x.dupOf, x.dupCount]))
})

// ---- 6. ssrf ipRejectReason（DNS 解析后复查） ----

test('audit: ipRejectReason 分类解析后的地址', async () => {
  const { ipRejectReason } = await import(core + 'ssrf.js')
  for (const bad of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '100.100.1.1', 'fe80::1', 'fd00::5', '::1', '::ffff:127.0.0.1', '[fe80::1%en0]', '0.0.0.0', '255.255.255.255']) {
    assert.ok(ipRejectReason(bad), `expected reject: ${bad}`)
  }
  for (const ok of ['8.8.8.8', '2606:4700::1111', '1.1.1.1']) {
    assert.equal(ipRejectReason(ok), null, `expected allow: ${ok}`)
  }
})

// ---- 7. API 同源收紧 + briefs/digest day 校验 + restore/import 门控 ----

const mkReq = (method, url, body, headers = {}) => ({
  method, url, headers,
  on(ev, cb) { if (ev === 'end') setImmediate(cb); if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body))) },
})
const mkRes = () => {
  const r = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b ?? '' } }
  return r
}

test('audit: sameSite 收紧——same-site 403，same-origin/无头放行', async () => {
  const { mountApi } = await import('../lib/api.js')
  const { Store } = await import(core + 'store.js')
  const { PrefsStore } = await import(core + 'prefs.js')
  const store = new Store({ path: join(mkdtempSync(join(tmpdir(), 'rnd-audit-api-')), 's.json') })
  await store.load()
  const deps = {
    store,
    prefs: new PrefsStore(join(mkdtempSync(join(tmpdir(), 'rnd-audit-p-')), 'p.json')),
    svc: { status: () => ({ sources: 0, enabled: 0, items: 0, lastFetchAt: '', lastDigestDay: '', failures: [] }) },
    configSources: [], timezone: '', readerPageSize: 50, digestsDir: mkdtempSync(join(tmpdir(), 'rnd-audit-dg-')),
    runDigest: async () => {},
  }
  const regs = []
  mountApi({ register: (o) => { regs.push(o); return () => {} } }, deps)
  const status = regs.find((r) => r.path === '/dsh-rss-news-daily/api/status')?.handler
  assert.ok(status)
  for (const [site, want] of [['same-site', 403], ['cross-site', 403], ['same-origin', 200], ['', 200]]) {
    const res = mkRes()
    await status(mkReq('GET', '/dsh-rss-news-daily/api/status', undefined, { 'sec-fetch-site': site }), res)
    assert.equal(res.statusCode, want, `sec-fetch-site=${JSON.stringify(site)}`)
  }
})

test('audit: /api/briefs day/type 白名单、/api/digest day 白名单', async () => {
  const { mountApi } = await import('../lib/api.js')
  const { Store } = await import(core + 'store.js')
  const { PrefsStore } = await import(core + 'prefs.js')
  const store = new Store({ path: join(mkdtempSync(join(tmpdir(), 'rnd-audit-bf-')), 's.json') })
  await store.load()
  const digestsDir = mkdtempSync(join(tmpdir(), 'rnd-audit-dg2-'))
  const deps = {
    store,
    prefs: new PrefsStore(join(mkdtempSync(join(tmpdir(), 'rnd-audit-p2-')), 'p.json')),
    svc: {}, configSources: [], timezone: '', readerPageSize: 50, digestsDir, runDigest: async () => {},
  }
  const regs = []
  mountApi({ register: (o) => { regs.push(o); return () => {} } }, deps)
  const briefs = regs.find((r) => r.path === '/dsh-rss-news-daily/api/briefs')?.handler
  const digest = regs.find((r) => r.path === '/dsh-rss-news-daily/api/digest')?.handler
  let res = mkRes()
  await briefs(mkReq('GET', '/dsh-rss-news-daily/api/briefs?day=../../x'), res)
  assert.equal(res.statusCode, 400)
  res = mkRes()
  await briefs(mkReq('GET', '/dsh-rss-news-daily/api/briefs?type=../../evil'), res)
  assert.equal(res.statusCode, 400)
  res = mkRes()
  await digest(mkReq('GET', '/dsh-rss-news-daily/api/digest/..%2F..%2Fetc'), res)
  assert.equal(res.statusCode, 404, 'non-day path rejected outright')
  res = mkRes()
  await briefs(mkReq('GET', '/dsh-rss-news-daily/api/briefs?day=2026-11-18'), res)
  assert.equal(res.statusCode, 404, 'valid day with no file → clean 404')
})

test('audit: /api/restore 非 .zip 拒绝、/api/import 非 .ndjson 拒绝', async () => {
  const { mountApi } = await import('../lib/api.js')
  const { SqliteStore } = await import(core + 'sqlite-store.js')
  const { PrefsStore } = await import(core + 'prefs.js')
  const dir = mkdtempSync(join(tmpdir(), 'rnd-audit-rt-'))
  const store = new SqliteStore({ path: join(dir, 'store.db') })
  await store.load()
  const deps = {
    store,
    prefs: new PrefsStore(join(dir, 'prefs.json')),
    svc: {}, configSources: [], timezone: '', readerPageSize: 50, digestsDir: join(dir, 'digests'),
    runDigest: async () => {},
  }
  const regs = []
  mountApi({ register: (o) => { regs.push(o); return () => {} } }, deps)
  const restore = regs.find((r) => r.path === '/dsh-rss-news-daily/api/restore')?.handler
  const imp = regs.find((r) => r.path === '/dsh-rss-news-daily/api/import')?.handler
  let res = mkRes()
  await restore(mkReq('POST', '/dsh-rss-news-daily/api/restore', { path: '/tmp/anything.txt' }), res)
  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body).error, /\.zip/)
  res = mkRes()
  await imp(mkReq('POST', '/dsh-rss-news-daily/api/import', { path: '/etc/passwd' }), res)
  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body).error, /ndjson/)
})

// ---- 8. tokenStats days 上限 ----

test('audit: tokenStats days 桶按 400 天上限收敛', async () => {
  const { addTokenStats } = await import(core + 'token-stats.js')
  const meta = {}
  for (let i = 0; i < 450; i++) {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400e3).toISOString().slice(0, 10)
    addTokenStats(meta, 'digest', { inputTokens: 1, outputTokens: 1 }, d)
  }
  const keys = Object.keys(meta.tokenStats.days)
  assert.equal(keys.length, 400, 'capped at 400 day buckets')
  assert.equal(meta.tokenStats.totalIn, 450, 'lifetime totals unaffected')
  assert.ok(!meta.tokenStats.days['2025-01-01'], 'oldest buckets pruned')
  assert.ok(meta.tokenStats.days[keys[0]] < meta.tokenStats.days[keys[399]] || keys[0] > '2025-01-01', 'kept buckets are the newest')
})
