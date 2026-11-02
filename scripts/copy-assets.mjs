/** build 后把运行期资产拷进 lib/（tsc 不复制非 ts 文件）。 */
import { copyFileSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
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

// index.html 静态引用加 ?v=版本：webview 会缓存 app.js/style.css，不戳破重启后仍跑旧前端
const v = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const htmlFile = join(root, 'lib', 'web', 'index.html')
const html = readFileSync(htmlFile, 'utf8').replace(/(href|src)="(web\/[^"?]+)"/g, `$1="$2?v=${v}"`)
writeFileSync(htmlFile, html)
console.log(`stamped: web/index.html assets ?v=${v}`)
