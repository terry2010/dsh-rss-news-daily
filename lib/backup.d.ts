/**
 * 备份/恢复：单文件 zip 打包 store.db + digests/ + prefs.json。
 * 恢复不热替换（sqlite 连接开着）——解压到 .restore-pending/，下次启动开库前覆盖写回。
 */
export declare const backupDirOf: (d: string) => string;
/** 打包数据目录为一个 rss-backup-<stamp>.zip，并按 keep 删最旧。返回 zip 路径。 */
export declare function runBackupZip(dataDir: string, store: {
    snapshot?: (f: string) => void;
}, destDir: string, keep?: number): Promise<string>;
/** 解 zip 到 <dataDir>/.restore-pending/（整体覆盖留到下次启动前执行）。 */
export declare function stageRestore(dataDir: string, zipPath: string): Promise<{
    files: number;
}>;
/** 启动时（开库前，同步）应用 pending 恢复：store.db/prefs.json 覆盖、digests 整体替换。 */
export declare function applyPendingRestore(dataDir: string, log?: {
    info: (m: string) => void;
    warn: (m: string) => void;
}): boolean;
//# sourceMappingURL=backup.d.ts.map