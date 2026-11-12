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
/** 注入点：测试可换 fake spawn。 */
export interface NotifyDeps {
    spawn?: typeof nodeSpawn;
    /** helper 路径覆盖（测试用）；默认取包内 native/RndNotify.app */
    helperBin?: string;
    /** 平台覆盖（测试用） */
    platform?: NodeJS.Platform;
}
/** 通知点击后的动作；url 为空表示「只展示、不可点」。 */
export interface ClickTarget {
    /** 点击后交给 /usr/bin/open 的 URL（dsh:// 深链或 http(s) 直达页） */
    url?: string;
    /** 点击时写的接力标记文件（仅 macOS helper 生效；client.js watchFile 接它切视图） */
    flagFile?: string;
}
export declare function desktopNotify(title: string, body: string, click?: ClickTarget, deps?: NotifyDeps): void;
//# sourceMappingURL=notify.d.ts.map