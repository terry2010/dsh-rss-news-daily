/** backup.ts 单测：digests 子目录（briefs/topics/index.json）与 companions 全量进包、恢复落位。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { runBackupZip, stageRestore, applyPendingRestore } = await import('../lib/backup.js')

test('backup: 快报子目录与伴随插件数据全量打包并可恢复', async () => {
  const src = mkdtempSync(join(tmpdir(), 'rnd-bak-src-'))
  const dst = mkdtempSync(join(tmpdir(), 'rnd-bak-dst-'))
  const out = mkdtempSync(join(tmpdir(), 'rnd-bak-out-'))
  try {
    mkdirSync(join(src, 'digests', 'briefs'), { recursive: true })
    mkdirSync(join(src, 'digests', 'topics'), { recursive: true })
    mkdirSync(join(src, 'companions', 'news-kuaixun'), { recursive: true })
    writeFileSync(join(src, 'prefs.json'), '{}')
    writeFileSync(join(src, 'digests', '2026-11-17-hourly.md'), '# hourly')
    writeFileSync(join(src, 'digests', 'briefs', '2026-11-17-kx-flash.md'), '# kx')
    writeFileSync(join(src, 'digests', 'topics', 't1.md'), '# topic')
    writeFileSync(join(src, 'digests', 'index.json'), '[]')
    writeFileSync(join(src, 'companions', 'news-kuaixun', 'kuaixun.db'), 'dbbytes')
    writeFileSync(join(src, 'companions', 'news-kuaixun', 'alerts.json'), '[]')
    const store = { dbFileSize: () => 1, snapshot: (f) => writeFileSync(f, 'store') }
    const zip = await runBackupZip(src, store, out)
    const st = await stageRestore(dst, zip)
    assert.ok(st.files >= 6)
    assert.equal(applyPendingRestore(dst), true)
    assert.equal(readFileSync(join(dst, 'digests', 'briefs', '2026-11-17-kx-flash.md'), 'utf8'), '# kx')
    assert.equal(readFileSync(join(dst, 'digests', 'topics', 't1.md'), 'utf8'), '# topic')
    assert.equal(readFileSync(join(dst, 'digests', 'index.json'), 'utf8'), '[]')
    assert.equal(readFileSync(join(dst, 'companions', 'news-kuaixun', 'kuaixun.db'), 'utf8'), 'dbbytes')
    assert.equal(readFileSync(join(dst, 'companions', 'news-kuaixun', 'alerts.json'), 'utf8'), '[]')
    assert.equal(readFileSync(join(dst, 'store.db'), 'utf8'), 'store')
  } finally {
    rmSync(src, { recursive: true, force: true })
    rmSync(dst, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})
