/**
 * 极简 ZIP 读写：deflate 压缩 + CRC32，无外部依赖。
 * 备份打包 store.db/digests/prefs.json → 单文件 .zip；恢复时反向解出。
 */
export interface ZipEntry {
    name: string;
    data: Buffer;
}
/** 打包：{name,data} 列表 → 完整 zip Buffer（能 deflate 就用，存不下就 store） */
export declare function zipEntries(entries: ZipEntry[]): Buffer;
/** 解包：zip Buffer → {name,data} 列表（支持 deflate/store） */
export declare function unzipEntries(buf: Buffer): ZipEntry[];
//# sourceMappingURL=zip.d.ts.map