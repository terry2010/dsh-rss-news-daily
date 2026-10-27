/** build 后把运行期资产拷进 lib/（tsc 不复制非 ts 文件）。 */
import { copyFileSync, mkdirSync, cpSync } from 'node:fs'
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
