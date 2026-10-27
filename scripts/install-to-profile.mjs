/**
 * 把本插件以"真实目录"装进 dsh profile（开发/测试用）。
 * 用法: node scripts/install-to-profile.mjs <profile名，默认 desktop>
 *
 * 为什么不用 `dsh plugin add <路径>`：它会装成 link: 软链，Node 按真实路径
 * 解析模块——插件目录内没有 node_modules 时 @deepseek-ai/* 全部解析失败。
 * 本脚本把 lib/ + web/ + 元数据**复制**为 profile node_modules 下的真实目录，
 * 再在 profile package.json 幂等登记依赖与 bundles 条目。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'

const profile = process.argv[2] || 'desktop'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const profileDir = join(homedir(), '.dsh', 'profiles', profile)
const target = join(profileDir, 'node_modules', 'dsh-rss-news-daily')

if (!existsSync(profileDir)) {
  console.error(`profile 不存在: ${profileDir}`)
  process.exit(1)
}

execSync('npm run build', { cwd: root, stdio: 'inherit' })

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const p of ['lib', 'web', 'cordis.patch.yml', 'package.json', 'README.md']) {
  const src = join(root, p)
  if (existsSync(src)) cpSync(src, join(target, p), { recursive: true })
}

const pkgPath = join(profileDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies['dsh-rss-news-daily'] = `file:${target}`
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []
if (!pkg.dsh.profile.bundles.includes('dsh-rss-news-daily')) {
  pkg.dsh.profile.bundles.push('dsh-rss-news-daily')
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`installed -> ${target}`)
console.log(`bundle registered in ${profile}/package.json; 重启 dsh 生效`)
