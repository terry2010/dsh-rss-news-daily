/** 全量抓取校验内置源目录：每源延迟/HTTP 状态/条目数。用法: npm run sources:check */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { sources } = JSON.parse(readFileSync(join(root, 'src/sources.builtin.json'), 'utf8'))

const TIMEOUT = 12_000
const CONCURRENCY = 8

async function check(src) {
  const t0 = performance.now()
  try {
    const res = await fetch(src.url, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'user-agent': 'dsh-rss-news-daily sources-check/0.1' },
      redirect: 'follow',
    })
    const ms = Math.round(performance.now() - t0)
    if (!res.ok) return { ...src, ok: false, ms, err: `HTTP ${res.status}` }
    const text = await res.text()
    const items = (text.match(/<(item|entry)[\s>]/g) || []).length
    return { ...src, ok: true, ms, items }
  } catch (e) {
    return { ...src, ok: false, ms: Math.round(performance.now() - t0), err: String(e?.cause?.code || e?.message || e).slice(0, 60) }
  }
}

const results = []
for (let i = 0; i < sources.length; i += CONCURRENCY) {
  results.push(...await Promise.all(sources.slice(i, i + CONCURRENCY).map(check)))
}
results.sort((a, b) => (a.ok === b.ok ? a.ms - b.ms : a.ok ? -1 : 1))
for (const r of results) {
  const flag = r.ok ? '✅' : '❌'
  console.log(`${flag} ${String(r.ms).padStart(6)}ms  ${r.name.padEnd(20)} ${r.ok ? `${r.items} items` : r.err}`)
}
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length}/${results.length} ok; ${bad.length} failed:`)
for (const r of bad) console.log(`  - ${r.name}: ${r.err}`)
process.exit(bad.length ? 1 : 0)
