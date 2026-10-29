import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const core = '../lib/core/'

const RSS2 = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>Test Feed</title>
<item><title>News A</title><link>https://a.example/1</link>
<description>&lt;p&gt;Hello &amp;amp; world&lt;/p&gt;</description>
<pubDate>Mon, 27 Oct 2026 08:00:00 GMT</pubDate><guid>a-1</guid></item>
<item><title>News B</title><link>https://a.example/2</link>
<description>second</description></item>
</channel></rss>`

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Feed</title>
<entry><title>Entry X</title><link href="https://b.example/x"/>
<summary>sum x</summary><id>b-x</id><updated>2026-10-27T09:00:00Z</updated></entry>
</feed>`

test('parser: RSS2 items, entities, stripHtml', async () => {
  const { parseFeedDocument, stripHtml } = await import(core + 'parser.js')
  const feed = parseFeedDocument(RSS2)
  assert.equal(feed.title, 'Test Feed')
  assert.equal(feed.items.length, 2)
  assert.equal(feed.items[0].id, 'a-1')
  assert.match(feed.items[0].summary, /Hello.*world/)
  assert.equal(stripHtml('<p>hi <b>x</b></p>'), 'hi x')
})

test('parser: Atom entry', async () => {
  const { parseFeedDocument } = await import(core + 'parser.js')
  const feed = parseFeedDocument(ATOM)
  assert.equal(feed.items[0].title, 'Entry X')
  assert.equal(feed.items[0].link, 'https://b.example/x')
  assert.equal(feed.items[0].id, 'b-x')
})

test('dedupe: exact hash + jaccard fuzzy (中文 bigram)', async () => {
  const { itemHash, findDuplicate, tokenSimilarity } = await import(core + 'dedupe.js')
  const h = itemHash('AI 发布新模型', 'body', false)
  assert.equal(findDuplicate({ title: 'AI 发布新模型', hash: h }, [{ title: 'x', hash: h }], { threshold: 0.9, compareContent: false })?.hash, h)
  assert.ok(tokenSimilarity('微软推出新AI模型', '微软推出全新AI模型') > 0.4)
  assert.equal(findDuplicate({ title: '完全无关的新闻标题', hash: 'q' }, [{ title: 'AI 发布新模型', hash: 'p' }], { threshold: 0.85, compareContent: false }), undefined)
})

test('ssrf: rejects private, allows public', async () => {
  const { ssrfRejectReason } = await import(core + 'ssrf.js')
  for (const bad of ['http://127.0.0.1/x', 'http://192.168.1.1/f', 'http://10.0.0.5/', 'https://foo.local/', 'ftp://x.com/f', 'http://user:pass@example.com/']) {
    assert.ok(ssrfRejectReason(bad), `expected reject: ${bad}`)
  }
  for (const ok of ['https://example.com/f', 'https://hnrss.org/frontpage']) {
    assert.equal(ssrfRejectReason(ok), null, `expected allow: ${ok}`)
  }
  // M1 评审穿透用例回归
  for (const bad of ['http://localhost./', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:169.254.169.254]/', 'http://[64:ff9b::a9fe:a9fe]/']) {
    assert.ok(ssrfRejectReason(bad), `expected reject (bypass): ${bad}`)
  }
})

test('fetcher: 公网 302 到内网被拦截（逐跳 SSRF）', async () => {
  const { createFetcher } = await import(core + 'fetcher.js')
  const fetcher = createFetcher({
    retries: 0,
    fetchImpl: async (url, init) => {
      if (init?.redirect !== 'manual') throw new Error('redirect must be manual for per-hop SSRF')
      if (url === 'https://pub.example/feed') {
        return { status: 302, ok: false, headers: new Headers({ location: 'http://169.254.169.254/x' }) }
      }
      throw new Error(`should never reach inner target: ${url}`)
    },
  })
  const r = await fetcher('https://pub.example/feed')
  assert.ok('error' in r && r.error.includes('SSRF'))
})

test('fetcher: 多 chunk body 顺序保持（探测期 buffered 不得排到末尾）', async () => {
  const { createFetcher } = await import(core + 'fetcher.js')
  const xml = '<?xml version="1.0"?><rss version="2.0"><channel>' + '<item><title>x</title></item>'.repeat(60) + '</channel></rss>'
  const bytes = new TextEncoder().encode(xml)
  // 切成 3 块：首块 < 512B 探测窗口 → 走 buffered；后续走 live decode
  const c1 = bytes.subarray(0, 300), c2 = bytes.subarray(300, 4000), c3 = bytes.subarray(4000)
  const fetcher = createFetcher({
    requestTimeoutMs: 5000, sizeLimitBytes: 1024 * 1024, retries: 0,
    fetchImpl: async () => new Response(
      new ReadableStream({ start(c) { c.enqueue(c1); c.enqueue(c2); c.enqueue(c3); c.close() } }),
      { status: 200, headers: { 'content-type': 'application/xml' } },
    ),
    log: { info() {}, warn() {}, error() {} },
  })
  const doc = await fetcher('https://x/feed')
  assert.equal(doc.status, 200)
  assert.ok(doc.body.startsWith('<?xml'), `body head must be the XML prolog, got: ${doc.body.slice(0, 40)}`)
  assert.ok(doc.body.endsWith('</rss>'), 'body tail must be document end')
  assert.equal(doc.body.length, xml.length)
  const { parseFeedDocument } = await import(core + 'parser.js')
  assert.equal(parseFeedDocument(doc.body).items.length, 60, 'parsed items must survive multi-chunk decode')
})

test('store: atomic save/load, corrupt isolation, extra fields preserved', async () => {
  const { Store, normalizeStoreData } = await import(core + 'store.js')
  const dir = mkdtempSync(join(tmpdir(), 'rnd-store-'))
  const file = join(dir, 'store.json')
  const st = new Store({ path: file, maxItems: 10 })
  await st.load()
  st.addSource({ id: 's1', url: 'https://x/feed', title: 'X', enabled: true, addedAt: '2026-10-27', category: 'AI', tier: 1, health: { ok: 1, fail: 0, failStreak: 0 } })
  st.addItems([{ id: 'i1', sourceId: 's1', title: 'T', link: 'l', summary: '', content: '', publishedAt: '', fetchedAt: '2026-10-27', hash: 'h', digestedDay: '', topic: 'AI', score: 5, reasons: ['热度'], state: { read: false, hidden: false, liked: 0 } }])
  await st.save()

  const st2 = new Store({ path: file })
  await st2.load()
  assert.equal(st2.sources[0].tier, 1)
  assert.equal(st2.sources[0].category, 'AI')
  assert.equal(st2.items[0].score, 5)
  assert.equal(st2.items[0].state.read, false)

  writeFileSync(file, '{broken json', 'utf8')
  const st3 = new Store({ path: file })
  await st3.load()
  assert.equal(st3.items.length, 0)
  assert.ok(readdirSync(dir).some((f) => f.includes('.corrupt-')))
})

test('store.addItems: id 去重，已有项不被覆盖（merge 语义）', async () => {
  const { Store } = await import(core + 'store.js')
  const dir = mkdtempSync(join(tmpdir(), 'rnd-store2-'))
  const st = new Store({ path: join(dir, 's.json') })
  await st.load()
  const base = { sourceId: 's', link: 'l', summary: '', content: '', publishedAt: '', hash: 'h1', digestedDay: '', topic: 'AI', score: 0, reasons: [], state: { read: false, hidden: false, liked: 0 } }
  st.addItems([{ ...base, id: 'i1', title: 'old', fetchedAt: '2026-10-01' }])
  const added = st.addItems([{ ...base, id: 'i1', title: 'new-title', fetchedAt: '2026-10-27' }, { ...base, id: 'i2', title: 'other', fetchedAt: '2026-10-27' }])
  assert.equal(added, 1)
  assert.equal(st.items.find((i) => i.id === 'i1').title, 'old')
  assert.equal(st.items.find((i) => i.id === 'i1').fetchedAt, '2026-10-01')
})

test('JSON store: 删除源级联清条目，clearItems 持久化清空', async () => {
  const { Store } = await import(core + 'store.js')
  const dir = mkdtempSync(join(tmpdir(), 'rnd-store-clear-'))
  const file = join(dir, 's.json')
  const st = new Store({ path: file })
  await st.load()
  st.addSource({ id: 'source-1', url: 'https://x/feed', title: 'X', enabled: true, addedAt: '', category: 'AI', tier: 1, health: { ok: 0, fail: 0, failStreak: 0 } })
  st.addItems([
    { id: 'item-1', sourceId: 'source-1', title: 'one', link: '', summary: '', content: '', publishedAt: '', fetchedAt: '2026-10-27', hash: 'h1', digestedDay: '', topic: 'AI', score: 0, reasons: [], state: { read: false, hidden: false, liked: 0 } },
    { id: 'item-2', sourceId: 'source-2', title: 'two', link: '', summary: '', content: '', publishedAt: '', fetchedAt: '2026-10-27', hash: 'h2', digestedDay: '', topic: 'AI', score: 0, reasons: [], state: { read: false, hidden: false, liked: 0 } },
  ])
  assert.equal(st.removeSource('source-1'), true)
  assert.deepEqual(st.items.map((item) => item.id), ['item-2'])
  assert.equal(st.clearItems(), 1)
  await st.save()
  const restored = new Store({ path: file })
  await restored.load()
  assert.equal(restored.items.length, 0)
})
