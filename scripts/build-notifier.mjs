/**
 * 构建 assets/notify/RndNotify.app —— 可点击桌面通知 helper。
 * 用法: node scripts/build-notifier.mjs
 * 需要 macOS + Xcode CLT（swiftc）。产物入库（~60KB），发版包内自带。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'scripts', 'notify.swift')
const app = join(root, 'native', 'RndNotify.app')
const bin = join(app, 'Contents', 'MacOS', 'RndNotify')

if (process.platform !== 'darwin') {
  console.error('RndNotify 只能在 macOS 上构建')
  process.exit(1)
}

rmSync(app, { recursive: true, force: true })
mkdirSync(dirname(bin), { recursive: true })
execFileSync('xcrun', ['swiftc', '-O', '-o', bin, src], { stdio: 'inherit' })
chmodSync(bin, 0o755)

writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dsh.rssnewsdaily.notify</string>
  <key>CFBundleName</key><string>新闻快报</string>
  <key>CFBundleExecutable</key><string>RndNotify</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`)

// ad-hoc 签名：无证书可跑，且避免部分系统对未签名 Mach-O 的额外校验
execFileSync('codesign', ['--sign', '-', '--force', app], { stdio: 'inherit' })
console.log(`built ${app} ${existsSync(bin) ? '' : '(missing!)'}`)
