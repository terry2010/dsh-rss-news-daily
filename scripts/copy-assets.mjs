/** build 后把运行期资产拷进 lib/（tsc 不复制非 ts 文件）。 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

mkdirSync(join(root, 'lib'), { recursive: true })
copyFileSync(join(root, 'src/sources.builtin.json'), join(root, 'lib/sources.builtin.json'))
console.log('copied: src/sources.builtin.json -> lib/')
