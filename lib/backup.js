/**
 * 备份/恢复：单文件 zip 打包 store.db + digests/ + prefs.json。
 * 恢复不热替换（sqlite 连接开着）——解压到 .restore-pending/，下次启动开库前覆盖写回。
 */
import { copyFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { zipEntries, unzipEntries } from './core/zip.js';
export const backupDirOf = (d) => join(d.replace(/^~(?=$|\/)/, homedir()));
const BACKUP_PREFIX = 'rss-backup-';
/** 超过此大小的库不再打 zip：readFileSync 整库→内存 zip→deflate 既撞 Buffer 上限（~4GB）
    又是纯同步 CPU+内存双杀。大库改走 WAL checkpoint + 旁车 .db 文件拷贝。 */
const BACKUP_ZIP_MAX_DB = 512 * 1024 ** 2; // 512MB
/** 打包数据目录：小库 → zip 内嵌 store.db；大库 → zip 只装元数据 + 旁车 rss-backup-<stamp>.db。
    按 keep 删最旧（zip 与其旁车一起清）。返回 zip 路径。 */
export async function runBackupZip(dataDir, store, destDir, keep = 7) {
    await mkdir(destDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const zipPath = join(destDir, `${BACKUP_PREFIX}${stamp}.zip`);
    const entries = [];
    const dbSize = store.dbFileSize?.() ?? 0;
    if (dbSize > 0 && dbSize <= BACKUP_ZIP_MAX_DB) {
        const tmpDb = join(destDir, `.rss-backup-${process.pid}-${Date.now()}.db`);
        store.snapshot?.(tmpDb); // 小库：VACUUM INTO 快照 + quick_check 预检
        if (existsSync(tmpDb)) {
            entries.push({ name: 'store.db', data: readFileSync(tmpDb) });
            await rm(tmpDb, { force: true }).catch(() => { });
        }
    }
    else if (dbSize > BACKUP_ZIP_MAX_DB && store.checkpointWal && store.dbPath) {
        // 大库：checkpoint(TRUNCATE) 把 WAL 并入主文件→主文件即一致快照点；
        // 异步文件拷贝走线程池 IO——不堵事件循环、不碰 Buffer 上限、不做 deflate CPU
        store.checkpointWal();
        await cp(store.dbPath, join(destDir, `${BACKUP_PREFIX}${stamp}.db`));
    }
    const prefsFile = join(dataDir, 'prefs.json');
    if (existsSync(prefsFile))
        entries.push({ name: 'prefs.json', data: readFileSync(prefsFile) });
    const ddir = join(dataDir, 'digests');
    if (existsSync(ddir)) {
        for (const f of (await readdir(ddir)).filter((f) => f.endsWith('.md')).sort())
            entries.push({ name: `digests/${f}`, data: readFileSync(join(ddir, f)) });
    }
    writeFileSync(zipPath, zipEntries(entries));
    const zips = (await readdir(destDir)).filter((n) => n.startsWith(BACKUP_PREFIX) && n.endsWith('.zip')).sort();
    for (const old of zips.slice(0, Math.max(0, zips.length - Math.max(1, keep)))) {
        await rm(join(destDir, old), { force: true }).catch(() => { });
        await rm(join(destDir, old.replace(/\.zip$/, '.db')), { force: true }).catch(() => { }); // 连旁车一起清
    }
    return zipPath;
}
/** 解 zip 到 <dataDir>/.restore-pending/（整体覆盖留到下次启动前执行）。
    大库备份的 store.db 在旁车同名 .db 文件——一并搬进 pending。 */
export async function stageRestore(dataDir, zipPath) {
    const zf = backupDirOf(zipPath);
    const entries = unzipEntries(readFileSync(zf));
    const sidecar = zf.replace(/\.zip$/i, '.db');
    const dbInZip = entries.find((e) => e.name === 'store.db');
    if (!dbInZip && !existsSync(sidecar))
        throw new Error('备份里没有 store.db（zip 或旁车 .db 都没有），不是本插件的备份包');
    const pending = join(dataDir, '.restore-pending');
    await rm(pending, { recursive: true, force: true });
    for (const e of entries) {
        if (e.name.includes('..') || e.name.startsWith('/') || e.name.endsWith('/'))
            continue; // 防路径穿越
        const dest = join(pending, e.name);
        await mkdir(dirname(dest), { recursive: true });
        writeFileSync(dest, e.data);
    }
    if (!dbInZip)
        await cp(sidecar, join(pending, 'store.db'));
    return { files: entries.length + (dbInZip ? 0 : 1) };
}
/** 启动时（开库前，同步）应用 pending 恢复：store.db/prefs.json 覆盖、digests 整体替换。 */
export function applyPendingRestore(dataDir, log) {
    const pending = join(dataDir, '.restore-pending');
    if (!existsSync(pending))
        return false;
    try {
        const pdb = join(pending, 'store.db');
        if (existsSync(pdb)) {
            // 连带 WAL/SHM 清掉，避免旧日志混进恢复的库
            for (const ext of ['', '-wal', '-shm'])
                rmSync(join(dataDir, `store.db${ext}`), { force: true });
            copyFileSync(pdb, join(dataDir, 'store.db'));
        }
        const pp = join(pending, 'prefs.json');
        if (existsSync(pp))
            copyFileSync(pp, join(dataDir, 'prefs.json'));
        const pd = join(pending, 'digests');
        if (existsSync(pd)) {
            rmSync(join(dataDir, 'digests'), { recursive: true, force: true });
            cpSync(pd, join(dataDir, 'digests'), { recursive: true });
        }
        rmSync(pending, { recursive: true, force: true });
        log?.info('restore applied from pending stage');
        return true;
    }
    catch (e) {
        log?.warn(`restore apply failed: ${e}`);
        return false;
    }
}
//# sourceMappingURL=backup.js.map