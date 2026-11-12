/**
 * 桌面通知：快报生成后推送到系统通知中心。
 *
 * 点击行为按平台分：
 *  - macOS：自带 RndNotify.app helper（scripts/notify.swift 编译），
 *    点击回调里写 flagFile 接力标记再 /usr/bin/open url。
 *    helper 缺失/不可执行时降级 osascript display notification（能显示但不能点击）。
 *  - Linux：notify-send，无点击能力，仅展示。
 *  - Windows：PowerShell toast，无点击能力，仅展示。
 *
 * 纪律同 dsh-notification：spawn 的 ENOENT/EACCES 是异步 'error' 事件，
 * 必须挂 no-op 监听，否则缺二进制时会打挂整个宿主进程；
 * detached + unref，通知器绝不能把错误漏进 agent/调度循环。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const NOTIFIER_BIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'native', 'RndNotify.app', 'Contents', 'MacOS', 'RndNotify');
export function desktopNotify(title, body, click = {}, deps = {}) {
    const spawn = deps.spawn ?? nodeSpawn;
    const fire = (cmd, args) => {
        try {
            spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => { }).unref();
        }
        catch { /* 通知器失败不影响主流程 */ }
    };
    const platform = deps.platform ?? process.platform;
    if (platform === 'darwin') {
        const bin = deps.helperBin ?? NOTIFIER_BIN;
        if (bin && existsSync(bin)) {
            fire(bin, [title, body, click.url ?? '', click.flagFile ?? '']);
            return;
        }
        const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        fire('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`]);
    }
    else if (platform === 'linux') {
        fire('notify-send', [title, body]);
    }
    else if (platform === 'win32') {
        const esc = (s) => s.replace(/'/g, "''");
        const ps = [
            "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;",
            "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
            `$t.GetElementsByTagName('text').Item(0).AppendChild($t.CreateTextNode('${esc(title)}')) | Out-Null;`,
            `$t.GetElementsByTagName('text').Item(1).AppendChild($t.CreateTextNode('${esc(body)}')) | Out-Null;`,
            `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${esc(title)}').Show([Windows.UI.Notifications.ToastNotification]::new($t));`,
        ].join(' ');
        fire('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    }
}
//# sourceMappingURL=notify.js.map