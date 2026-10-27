import { test } from 'node:test'
import assert from 'node:assert/strict'

test('bundle contract: name/inject/Config/apply all exported', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'rss-news-daily')
  assert.ok(Array.isArray(mod.inject))
  for (const svc of ['timer', 'tools']) assert.ok(mod.inject.includes(svc), `inject missing ${svc}`)
  assert.ok(!mod.inject.includes('webServer'), 'webServer must stay optional (ctx.inject), not static')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(mod.Config, 'Config schema missing')
})

test('apply is callable with stub ctx and does not throw', async () => {
  const { apply } = await import('../lib/index.js')
  const logs = []
  const ctx = {
    logger: () => ({ info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) }),
    inject: (names, cb) => { cb?.({}) },
  }
  const { Config } = await import('../lib/index.js')
  // schemastery Config 直接当函数调用取默认值（cordis 加载器同款语义）
  const config = typeof Config === 'function' ? Config({}) : {}
  assert.doesNotThrow(() => apply(ctx, config))
  assert.ok(logs.some((m) => String(m).includes('loaded')), 'expected loaded log')
})

test('enabled=false: apply returns inert without IO', async () => {
  const { apply, Config } = await import('../lib/index.js')
  const logs = []
  const ctx = {
    logger: () => ({ info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) }),
    inject: () => { throw new Error('inject must not be called when disabled') },
  }
  const config = Config({ enabled: false })
  assert.doesNotThrow(() => apply(ctx, config))
  assert.ok(logs.some((m) => String(m).includes('inert')))
})

test('dataDir resolution: configured > $DSH_HOME > ~/.dsh', async () => {
  const { apply, Config } = await import('../lib/index.js')
  const logs = []
  const ctx = {
    logger: () => ({ info: (m) => logs.push(m), warn: () => {}, error: () => {} }),
    inject: () => {},
  }
  const prev = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/dsh-home-test'
    assert.doesNotThrow(() => apply(ctx, Config({})))
    assert.ok(logs.some((m) => String(m).includes('/tmp/dsh-home-test/data/rss-news-daily')), logs.join('|'))
    logs.length = 0
    assert.doesNotThrow(() => apply(ctx, Config({ dataDir: '/tmp/custom-dir' })))
    assert.ok(logs.some((m) => String(m).includes('/tmp/custom-dir')), logs.join('|'))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})
