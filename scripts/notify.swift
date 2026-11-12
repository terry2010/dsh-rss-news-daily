/**
 * RndNotify —— 可点击桌面通知 helper（macOS）。
 *
 * 为什么是它：osascript 的 `display notification` 没有点击回调；
 * 裸二进制没有 CFBundleIdentifier，现代 macOS 会把它的通知静默丢弃。
 * 所以编译成最小 .app（Info.plist + 本二进制 + ad-hoc 签名），
 * 用已废弃但仍可用的 NSUserNotification 拿 didActivate 点击回调。
 *
 * 用法: RndNotify <title> <body> [openUrl] [flagFile]
 *   点击通知 → 写 flagFile（JSON，宿主侧的"请切到快报视图"接力标记）
 *   → /usr/bin/open openUrl（非空时）→ 以 0 退出；10 分钟无点击以 2 退出。
 *
 * 构建见 scripts/build-notifier.mjs（swiftc + Info.plist + codesign -s -）。
 */
import Cocoa

final class Delegate: NSObject, NSUserNotificationCenterDelegate {
    let url: String
    let flagFile: String
    init(_ url: String, _ flagFile: String) { self.url = url; self.flagFile = flagFile }
    func userNotificationCenter(_ center: NSUserNotificationCenter, didActivate notification: NSUserNotification) {
        // 先落接力标记（client.js watchFile 收到后切快报视图），再唤起窗口。
        if !flagFile.isEmpty {
            let ts = ISO8601DateFormatter().string(from: Date())
            try? "{\"kind\":\"hourly\",\"at\":\"\(ts)\"}".write(toFile: flagFile, atomically: true, encoding: .utf8)
        }
        // 用 /usr/bin/open 而不是 NSWorkspace.open：与命令行 `open <url>` 行为
        // 完全一致（自定义 scheme 经 LaunchServices 路由到登记 app）。
        if !url.isEmpty {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            p.arguments = [url]
            try? p.run()
        }
        exit(0)
    }
    // 前台的宿主也要显示横幅（焦点在 dsh 窗口时通知仍要出现）。
    func userNotificationCenter(_ center: NSUserNotificationCenter, shouldPresent notification: NSUserNotification) -> Bool { true }
}

let args = CommandLine.arguments
let title = args.count > 1 ? args[1] : "新闻快报"
let body = args.count > 2 ? args[2] : ""
let url = args.count > 3 ? args[3] : ""
let flagFile = args.count > 4 ? args[4] : ""

let delegate = Delegate(url, flagFile)
NSUserNotificationCenter.default.delegate = delegate

let n = NSUserNotification()
n.title = title
n.informativeText = body
n.hasActionButton = false // 单击任意处即 activate
NSUserNotificationCenter.default.deliver(n)

// 横幅 5s 后收进通知中心；留 10 分钟让「从通知中心点开」也能回调。
DispatchQueue.main.asyncAfter(deadline: .now() + 600) { exit(2) }
RunLoop.main.run()
