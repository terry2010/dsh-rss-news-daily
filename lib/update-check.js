/**
 * 每日更新检查：挂在当日第一次抓取上——向 update 端点上报一次自身版本 +
 * 已安装伴随插件版本，拉回最新升级信息；每个自然日最多一次（成败都计）。
 *
 * 隐私口径（docs 详设 §2.4）：上行 {pkg, version, companions} + iid/d/t——
 * iid 是首跑生成的随机 uuid 安装标识（统计去重用，无机器信息），d 是上报日，
 * t 是绑定这些字段的 HMAC 签名（防污染，非安全边界）；无 OS/UA 指纹
 * （UA 仅 pkg/version 自身）。端点非 https 直接拒跑（防降级伪造更新信息）。
 *
 * 伴随插件版本来源：profile 清单 package.json 的 dependencies（cordis
 * registry 只有插件名没有版本）。manifest 定位 = 从自身模块路径向上找第一
 * 个含 dsh.profile.bundles 的 package.json；找不到回退扫 DSH_HOME/profiles。
 * file: spec（dev 安装）跟随读真实版本。
 *
 * fetch/fs/clock 全注入，纯逻辑可测。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zonedDayKey } from './core/time.js';
import { noopLog } from './core/types.js';
const RESPONSE_CAP = 16 * 1024;
const COMPANION_PREFIX = 'dsh-rss-news-';
/** 上报防污染签名 key——公开源码内，防随手伪造/扫描噪音，不防逆向。
 *  与 zhuikan.net/server/report_stats.py 的 REPORT_KEY 必须一致。 */
const REPORT_KEY = '9f4c2d7a1e5b83f60c4a9d2e7b153f8c6a0d4e9b2f7a5c3d8e1b6f0a4c9d2e7b';
/** 宽松 semver 比较：x[.y[.z]][-prerelease]。返回 -1|0|1。预发版 < 同号正式版。 */
export function compareSemver(a, b) {
    const parse = (v) => {
        const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-.]([0-9a-zA-Z.]+))?$/.exec(v.trim());
        if (!m)
            return null;
        return { num: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? '' };
    };
    const pa = parse(a), pb = parse(b);
    if (!pa || !pb)
        return 0; // 解析不出不比——宁可漏报不误报
    for (let i = 0; i < 3; i++)
        if (pa.num[i] !== pb.num[i])
            return pa.num[i] < pb.num[i] ? -1 : 1;
    if (pa.pre === pb.pre)
        return 0;
    if (!pa.pre)
        return 1;
    if (!pb.pre)
        return -1;
    return pa.pre < pb.pre ? -1 : 1;
}
/** 从 manifest dependencies 筛伴随插件：dsh-rss-news-* 前缀且 ≠ 自身。
 *  file: spec 交给 resolver 还原真实版本；还原不了就报 spec 字面量（如实上报）。 */
export function companionVersions(deps, selfPkg, resolveFileVer) {
    const out = {};
    for (const [name, spec] of Object.entries(deps)) {
        if (!name.startsWith(COMPANION_PREFIX) || name === selfPkg)
            continue;
        out[name] = spec.startsWith('file:') ? (resolveFileVer?.(spec) ?? spec) : spec.replace(/^[\^~]/, '');
    }
    return out;
}
function readManifest(pkgPath, selfPkg) {
    try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        const bundles = pkg.dsh?.profile?.bundles;
        if (!Array.isArray(bundles) || !bundles.includes(selfPkg))
            return undefined;
        return { deps: pkg.dependencies ?? {}, dir: dirname(pkgPath) };
    }
    catch {
        return undefined;
    }
}
/** manifest 定位主路径：从插件自身安装位置逐级向上，找含 dsh.profile.bundles
 *  （且 bundles 含本包）的 package.json——即当前运行 profile 的根。 */
export function findProfileDeps(fromDir, selfPkg) {
    let dir = resolve(fromDir);
    for (let i = 0; i < 12; i++) {
        const hit = readManifest(join(dir, 'package.json'), selfPkg);
        if (hit)
            return hit;
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
    return undefined;
}
/** 回退：dev link 等场景向上找不到时，扫 <dshHome>/profiles/*\/package.json，
 *  取第一个 bundles 含本包的 profile（确定性：目录名排序）。 */
export function scanProfileDeps(dshHome, selfPkg) {
    const profiles = join(dshHome, 'profiles');
    if (!existsSync(profiles))
        return undefined;
    for (const name of readdirSync(profiles).sort()) {
        const hit = readManifest(join(profiles, name, 'package.json'), selfPkg);
        if (hit)
            return hit;
    }
    return undefined;
}
/** 汇总：manifest 定位（向上→扫 profiles）→ file: 还原 → 伴随表。 */
export function listCompanions(selfPkg, opts = {}) {
    const manifest = (opts.fromDir ? findProfileDeps(opts.fromDir, selfPkg) : undefined)
        ?? (opts.dshHome ? scanProfileDeps(opts.dshHome, selfPkg) : undefined);
    if (!manifest)
        return {};
    return companionVersions(manifest.deps, selfPkg, (spec) => {
        const p = spec.slice(5); // 'file:'.length
        const abs = isAbsolute(p) ? p : resolve(manifest.dir, p);
        try {
            const v = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8')).version;
            return typeof v === 'string' ? v : undefined;
        }
        catch {
            return undefined;
        }
    });
}
/** 响应消毒：shape 不对/字段类型不对 → null（服务端被劫持也只能拿到"无更新"）。 */
export function sanitizeUpdateInfo(v) {
    if (typeof v !== 'object' || v === null)
        return null;
    const o = v;
    if (typeof o.latest !== 'string' || !/^\d+\.\d+/.test(o.latest))
        return null;
    const out = { latest: o.latest };
    if (typeof o.url === 'string' && /^https?:\/\//.test(o.url))
        out.url = o.url;
    if (typeof o.notes === 'string')
        out.notes = o.notes.slice(0, 200);
    if (typeof o.minSupported === 'string')
        out.minSupported = o.minSupported;
    if (typeof o.companions === 'object' && o.companions !== null) {
        const c = {};
        for (const [name, info] of Object.entries(o.companions)) {
            const i = info;
            if (typeof i?.latest === 'string') {
                c[name] = { latest: i.latest, ...(typeof i.url === 'string' && /^https?:\/\//.test(i.url) ? { url: i.url } : {}) };
            }
        }
        out.companions = c;
    }
    return out;
}
/** 上报签名：hmac(v1|iid|day|pkg|version|companionsJson)[:16hex] → "v1.<sig>"
 *  服务端 recompute 校验——篡改任一字段签名即失效（统计防污染，非安全边界）。 */
export function reportToken(opts) {
    const canon = `v1|${opts.iid}|${opts.day}|${opts.pkg}|${opts.version}|${opts.companionsJson}`;
    return `v1.${createHmac('sha256', opts.key ?? REPORT_KEY).update(canon).digest('hex').slice(0, 16)}`;
}
/** 打一次端点；任何失败/异常 → null（调用方只 log，不阻断主流程）。
 *  上报走 GET query——服务端是纯静态 nginx，access_log 即数据管线。 */
export async function runUpdateCheck(opts) {
    const log = opts.log || noopLog;
    if (!opts.endpoint.startsWith('https://')) {
        log.warn(`update check skipped: non-https endpoint ${opts.endpoint}`);
        return null;
    }
    let url;
    try {
        const u = new URL(opts.endpoint);
        const companionsJson = Object.keys(opts.report.companions).length ? JSON.stringify(opts.report.companions) : '';
        u.searchParams.set('pkg', opts.report.pkg);
        u.searchParams.set('version', opts.report.version);
        if (companionsJson)
            u.searchParams.set('companions', companionsJson);
        if (opts.installId && opts.day) {
            u.searchParams.set('iid', opts.installId);
            u.searchParams.set('d', opts.day);
            u.searchParams.set('t', reportToken({ iid: opts.installId, day: opts.day, pkg: opts.report.pkg, version: opts.report.version, companionsJson }));
        }
        url = u.toString();
    }
    catch {
        log.warn(`update check skipped: bad endpoint ${opts.endpoint}`);
        return null;
    }
    try {
        const res = await (opts.fetchImpl ?? fetch)(url, {
            headers: { 'user-agent': `${opts.report.pkg}/${opts.report.version}` },
            signal: AbortSignal.timeout(opts.timeoutMs),
        });
        if (!res.ok) {
            log.warn(`update check: HTTP ${res.status}`);
            return null;
        }
        const text = await res.text();
        if (text.length > RESPONSE_CAP) {
            log.warn('update check: response too large');
            return null;
        }
        return sanitizeUpdateInfo(JSON.parse(text));
    }
    catch (e) {
        log.warn(`update check failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}
/** 组装每日一次门控的更新检查。返回的函数挂在「当日第一次抓取」上调用——
 *  内部 lastAttemptDay 门控：enabled 关/当天已试过（成败都算）立即返回，可放心每轮抓取都调。 */
export function startUpdateCheck(opts) {
    const log = opts.log || noopLog;
    const fire = async () => {
        if (!opts.enabled())
            return;
        const today = zonedDayKey((opts.now ?? (() => new Date()))(), opts.timezone || undefined);
        const meta = opts.meta();
        if (meta.updateCheck?.lastAttemptDay === today)
            return; // 今天已试过（成败都算）
        meta.updateCheck = { ...(meta.updateCheck ?? { lastAttemptDay: '' }), lastAttemptDay: today };
        meta.updateCheck.installId ||= randomUUID(); // 首跑生成持久安装标识，随 meta 持久化
        opts.save();
        const info = await runUpdateCheck({
            endpoint: opts.endpoint(), timeoutMs: opts.timeoutMs,
            report: { pkg: opts.selfPkg, version: opts.selfVer, companions: opts.companions() },
            installId: meta.updateCheck.installId, day: today,
            fetchImpl: opts.fetchImpl, log,
        });
        if (!info)
            return;
        const hasUpdate = compareSemver(info.latest, opts.selfVer) > 0;
        meta.updateCheck = { ...meta.updateCheck, lastAttemptDay: today, lastCheckedAt: new Date().toISOString(), latest: info.latest, url: info.url, notes: info.notes, hasUpdate };
        opts.save();
        log.info(hasUpdate ? `update available: ${opts.selfVer} → ${info.latest}` : `update check: ${opts.selfVer} up to date`);
        if (hasUpdate)
            opts.onUpdate?.(info);
    };
    return () => fire().catch((e) => log.warn(`update check crashed: ${e instanceof Error ? e.message : String(e)}`));
}
//# sourceMappingURL=update-check.js.map