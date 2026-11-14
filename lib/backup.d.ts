/**
 * 备份/恢复：单文件 zip 打包 store.db + digests/ + prefs.json。
 * 恢复不热替换（sqlite 连接开着）——解压到 .restore-pending/，下次启动开库前覆盖写回。
 */
export declare const backupDirOf: (d: string) => string;
export interface BackupStore {
    snapshot?: (f: string) => void;
    dbFileSize?: () => number;
    checkpointWal?: () => void;
    dbPath?: string;
}
/** 打包数据目录：小库 → zip 内嵌 store.db；大库 → zip 只装元数据 + 旁车 rss-backup-<stamp>.db。
    按 keep 删最旧（zip 与其旁车一起清）。返回 zip 路径。 */
export declare function runBackupZip(dataDir: string, store: BackupStore, destDir: string, keep?: number): Promise<string>;
/** 解 zip 到 <dataDir>/.restore-pending/（整体覆盖留到下次启动前执行）。
    大库备份的 store.db 在旁车同名 .db 文件——一并搬进 pending。 */
export declare function stageRestore(dataDir: string, zipPath: string): Promise<{
    files: number;
}>;
/** 启动时（开库前，同步）应用 pending 恢复：store.db/prefs.json 覆盖、digests 整体替换。 */
export declare function applyPendingRestore(dataDir: string, log?: {
    info: (m: string) => void;
    warn: (m: string) => void;
}): boolean;
//# sourceMappingURL=backup.d.ts.map