import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Retry feed</title>
<item><title>English astronomy headline</title><link>https://news.example/item-1</link><guid>retry-item-1</guid><description>English astronomy summary</description></item>
</channel></rss>`
const req = (method, url, body) => ({
  method, url, headers: {},
  on(event, callback) {
    if (event === 'data' && body !== undefined) callback(Buffer.from(JSON.stringify(body)))
    if (event === 'end') setImmediate(callback)
  },
})
const res = () => ({ statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(value) { this.body = value ?? '' } })
const json = (r) => JSON.parse(r.body)

test('单源重试显示进度并走自动翻译，翻译完成后恢复空闲态', async () => {
  const { Config, apply } = await import('../lib/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'rnd-retry-integration-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'prefs.json'), JSON.stringify({ autoTranslate: true }))
  const feedUrl = 'https://news.example/feed'
  const oldFetch = globalThis.fetch
  let feedBody = RSS
  let releaseFeed
  let startedFeed
  let feedStarted
  const resetFeedGate = () => {
    feedStarted = new Promise((resolve) => { startedFeed = resolve })
    releaseFeed = undefined
  }
  resetFeedGate()
  globalThis.fetch = (_url, init) => new Promise((resolve, reject) => {
    releaseFeed = () => resolve(new Response(feedBody, { status: 200, headers: { 'content-type': 'application/rss+xml' } }))
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    startedFeed()
  })

  const registrations = []
  let toolsReady
  const ready = new Promise((resolve) => { toolsReady = resolve })
  let blockTranslation = false
  let translationStartedResolve
  const waitForTranslation = () => new Promise((resolve) => { translationStartedResolve = resolve })
  const llm = {
    listProviders: () => [{ id: 'test-provider' }],
    listModels: async () => [{ id: 'test-model' }],
    stream: async function* (request) {
      if (blockTranslation) {
        translationStartedResolve()
        await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }))
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } } }
        return
      }
      yield { type: 'text-delta', text: '标题：天文学标题\n正文：天文学摘要' }
    },
  }
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    tools: { register: () => { toolsReady(); return () => {} } },
    timeout: () => () => {},
    interval: () => () => {},
    inject(names, callback) {
      if (names[0] === 'llm') callback({ llm })
      if (names[0] === 'webServer') callback({ webServer: { register: (entry) => { registrations.push(entry); return () => {} } } })
    },
  }
  const config = Config({
    dataDir: dir,
    sources: [{ url: feedUrl, title: 'Retry feed', category: '科学' }],
    fetch: { enabled: false, scoreOnFetch: false, hourlyBrief: false },
  })
  const dispose = apply(ctx, config)
  try {
    await ready
    const route = (path) => registrations.find((entry) => entry.path === path)?.handler
    const patch = route('/dsh-rss-news-daily/api/sources')
      ? registrations.find((entry) => entry.kind === 'prefix' && entry.path === '/dsh-rss-news-daily/api/sources').handler
      : undefined
    assert.equal(typeof patch, 'function')
    const patchRes = res()
    const patchPromise = patch(req('PATCH', `/dsh-rss-news-daily/api/sources/${encodeURIComponent(feedUrl)}`, { action: 'retry' }), patchRes)

    await feedStarted
    const progressRes = res()
    await route('/dsh-rss-news-daily/api/fetch-progress')(req('GET', '/dsh-rss-news-daily/api/fetch-progress'), progressRes)
    const progress = json(progressRes)
    assert.equal(progress.running, true)
    assert.equal(progress.current, feedUrl)
    releaseFeed()
    await patchPromise
    assert.equal(patchRes.statusCode, 200)

    const itemsRes = res()
    await route('/dsh-rss-news-daily/api/items')(req('GET', '/dsh-rss-news-daily/api/items'), itemsRes)
    const item = json(itemsRes).items[0]
    assert.equal(item.state.translation, '天文学标题\n\n天文学摘要')

    const doneRes = res()
    await route('/dsh-rss-news-daily/api/fetch-progress')(req('GET', '/dsh-rss-news-daily/api/fetch-progress'), doneRes)
    assert.equal(json(doneRes).running, false)
    const statusRes = res()
    await route('/dsh-rss-news-daily/api/status')(req('GET', '/dsh-rss-news-daily/api/status'), statusRes)
    assert.equal(json(statusRes).lastAdded, 1)

    feedBody = RSS.replace('retry-item-1', 'retry-item-2')
      .replace('English astronomy headline', 'New English astronomy headline')
      .replace('item-1', 'item-2')
    resetFeedGate()
    blockTranslation = true
    const translating = waitForTranslation()
    const retryRes2 = res()
    const retryPromise2 = patch(req('PATCH', `/dsh-rss-news-daily/api/sources/${encodeURIComponent(feedUrl)}`, { action: 'retry' }), retryRes2)
    await feedStarted
    releaseFeed()
    await translating
    const translatingRes = res()
    await route('/dsh-rss-news-daily/api/fetch-progress')(req('GET', '/dsh-rss-news-daily/api/fetch-progress'), translatingRes)
    assert.equal(json(translatingRes).stage, 'translate')
    const cancelRes = res()
    await route('/dsh-rss-news-daily/api/fetch-cancel')(req('POST', '/dsh-rss-news-daily/api/fetch-cancel', {}), cancelRes)
    assert.equal(json(cancelRes).ok, true)
    await retryPromise2
    assert.equal(retryRes2.statusCode, 200)
    blockTranslation = false
    const finalItemsRes = res()
    await route('/dsh-rss-news-daily/api/items')(req('GET', '/dsh-rss-news-daily/api/items'), finalItemsRes)
    const cancelledItem = json(finalItemsRes).items.find((entry) => entry.id === 'retry-item-2')
    assert.ok(cancelledItem)
    assert.equal(cancelledItem.state.translation, undefined)
    const cancelledDoneRes = res()
    await route('/dsh-rss-news-daily/api/fetch-progress')(req('GET', '/dsh-rss-news-daily/api/fetch-progress'), cancelledDoneRes)
    assert.equal(json(cancelledDoneRes).running, false)
  } finally {
    dispose()
    globalThis.fetch = oldFetch
  }
})
