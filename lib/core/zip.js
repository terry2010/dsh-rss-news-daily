/**
 * 极简 ZIP 读写：deflate 压缩 + CRC32，无外部依赖。
 * 备份打包 store.db/digests/prefs.json → 单文件 .zip；恢复时反向解出。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++)
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(d) {
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
        date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) >>> 0,
    };
}
/** 打包：{name,data} 列表 → 完整 zip Buffer（能 deflate 就用，存不下就 store） */
export function zipEntries(entries) {
    const chunks = [];
    const central = [];
    const { time, date } = dosDateTime(new Date());
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
        const crc = crc32(e.data);
        const def = deflateRawSync(e.data, { level: 6 });
        const useDef = def.length < e.data.length;
        const payload = useDef ? def : e.data;
        const method = useDef ? 8 : 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(e.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28); // extra len
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(20, 4); // made by
        cen.writeUInt16LE(20, 6); // needed
        cen.writeUInt16LE(0x0800, 8);
        cen.writeUInt16LE(method, 10);
        cen.writeUInt16LE(time, 12);
        cen.writeUInt16LE(date, 14);
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(payload.length, 20);
        cen.writeUInt32LE(e.data.length, 24);
        cen.writeUInt16LE(name.length, 28);
        cen.writeUInt32LE(offset, 42); // local header offset
        chunks.push(local, name, payload);
        central.push(Buffer.concat([cen, name]));
        offset += 30 + name.length + payload.length;
    }
    const cd = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, cd, eocd]);
}
/** 解包：zip Buffer → {name,data} 列表（支持 deflate/store） */
export function unzipEntries(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65557; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0)
        throw new Error('不是有效的 zip 文件');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const out = [];
    for (let k = 0; k < count; k++) {
        if (buf.readUInt32LE(p) !== 0x02014b50)
            throw new Error('zip 中央目录损坏');
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nlen = buf.readUInt16LE(p + 28);
        const elen = buf.readUInt16LE(p + 30);
        const clen = buf.readUInt16LE(p + 32);
        const lhOff = buf.readUInt32LE(p + 42);
        const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
        const ln = buf.readUInt16LE(lhOff + 26);
        const le = buf.readUInt16LE(lhOff + 28);
        const raw = buf.subarray(lhOff + 30 + ln + le, lhOff + 30 + ln + le + compSize);
        const data = method === 8 ? inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
        if (!data)
            throw new Error(`zip 内 ${name} 使用了不支持的压缩方式 ${method}`);
        out.push({ name, data });
        p += 46 + nlen + elen + clen;
    }
    return out;
}
//# sourceMappingURL=zip.js.map