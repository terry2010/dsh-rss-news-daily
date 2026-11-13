/** build 后把运行期资产拷进 lib/（tsc 不复制非 ts 文件）。 */
import { copyFileSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

mkdirSync(join(root, 'lib'), { recursive: true })
for (const f of ['sources.builtin.json', 'client.js']) {
  copyFileSync(join(root, 'src', f), join(root, 'lib', f))
  console.log(`copied: src/${f} -> lib/`)
}
cpSync(join(root, 'web'), join(root, 'lib', 'web'), { recursive: true })
console.log('copied: web/ -> lib/web/')

// index.html 静态引用加 ?v=<文件内容hash>：webview 会缓存 app.js/style.css——
// 版本号在两版之间不变，dev 反复安装时 URL 相同戳不破缓存会跑旧前端；按内容戳变了必换 URL
const fallback = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const stamp = (ref) => {
  try { return createHash('sha256').update(readFileSync(join(root, 'lib', ref))).digest('hex').slice(0, 10) }
  catch { return fallback }
}
const htmlFile = join(root, 'lib', 'web', 'index.html')
const html = readFileSync(htmlFile, 'utf8').replace(/(href|src)="(web\/[^"?]+)"/g, (m, attr, ref) => `${attr}="${ref}?v=${stamp(ref)}"`)
writeFileSync(htmlFile, html)
console.log('stamped: web/index.html assets ?v=<content-hash>')
