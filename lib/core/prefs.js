/**
 * prefs.json 读写：用户偏好权重（topics/keywords/bannedKeywords/sourceWeight）。
 * M3 提供读写与消毒；M5 的 news_tune/反馈学习在此基础上增改权重。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { EMPTY_PREFS } from './scorer.js';
import { noopLog } from './types.js';
function numMapOf(v) {
    if (typeof v !== 'object' || v === null)
        return {};
    const out = {};
    for (const [k, n] of Object.entries(v)) {
        if (typeof n === 'number' && Number.isFinite(n))
            out[k] = n;
    }
    return out;
}
function strListOf(v) {
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0) : [];
}
/** 把未知输入消毒成 PrefsFile；畸形字段回默认，不抛错。 */
export function normalizePrefs(value) {
    const r = (typeof value === 'object' && value !== null ? value : {});
    const llm = (typeof r.llm === 'object' && r.llm !== null ? r.llm : {});
    const sched = (typeof r.schedule === 'object' && r.schedule !== null ? r.schedule : {});
    const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
    const times = (v) => strListOf(v).filter((t) => TIME_RE.test(t));
    return {
        topics: numMapOf(r.topics),
        keywords: numMapOf(r.keywords),
        bannedKeywords: strListOf(r.bannedKeywords),
        sourceWeight: numMapOf(r.sourceWeight),
        tuningHistory: Array.isArray(r.tuningHistory) ? r.tuningHistory : [],
        llm: typeof llm.provider === 'string' && typeof llm.model === 'string'
            ? { provider: llm.provider, model: llm.model }
            : undefined,
        schedule: Array.isArray(sched.digestTimes) || Array.isArray(sched.fetchTimes) || typeof sched.intervalMinutes === 'number' || typeof sched.onStartup === 'boolean'
            ? {
                digestTimes: times(sched.digestTimes), fetchTimes: times(sched.fetchTimes),
                ...(typeof sched.intervalMinutes === 'number' && Number.isFinite(sched.intervalMinutes) ? { intervalMinutes: sched.intervalMinutes } : {}),
                ...(typeof sched.onStartup === 'boolean' ? { onStartup: sched.onStartup } : {}),
            }
            : undefined,
        proxyUrl: typeof r.proxyUrl === 'string' && r.proxyUrl ? r.proxyUrl : undefined,
        autoTranslate: r.autoTranslate === true ? true : undefined,
        showNavEntry: r.showNavEntry === false ? false : undefined,
        loopGuard: typeof r.loopGuard === 'boolean' ? r.loopGuard : undefined,
        devLog: r.devLog === true ? true : undefined,
        backup: (() => { const b = (typeof r.backup === 'object' && r.backup !== null ? r.backup : {}); const period = b.period === 'week' || b.period === 'month' ? b.period : 'day'; const o = { enabled: b.enabled === true, period: period, dir: typeof b.dir === 'string' && b.dir ? b.dir : undefined, keep: typeof b.keep === 'number' && Number.isFinite(b.keep) && b.keep >= 1 ? Math.floor(b.keep) : 7 }; return (o.enabled || o.dir) ? o : undefined; })(),
        translateLlm: (() => { const t = (typeof r.translateLlm === 'object' && r.translateLlm !== null ? r.translateLlm : {}); return typeof t.provider === 'string' && typeof t.model === 'string' && t.provider && t.model ? { provider: t.provider, model: t.model } : undefined; })(),
        subscribedTopics: Array.isArray(r.subscribedTopics) ? r.subscribedTopics.filter((t) => typeof t === 'string' && !!t) : undefined,
        notifyDesktop: r.notifyDesktop === true ? true : undefined,
        digestOpts: (() => { const d = (typeof r.digestOpts === 'object' && r.digestOpts !== null ? r.digestOpts : {}); const b = (k) => typeof d[k] === 'boolean' ? d[k] : undefined; const num = (k) => typeof d[k] === 'number' && Number.isFinite(d[k]) ? d[k] : undefined; const o = { digestItems: num('digestItems'), perTopicLimit: num('perTopicLimit'), minLlmScore: num('minLlmScore'), candidateHours: num('candidateHours'), llmScoreCandidates: num('llmScoreCandidates'), candidateMax: num('candidateMax'), summaryMaxItems: num('summaryMaxItems'), summaryConcurrency: num('summaryConcurrency'), digestMaxLength: num('digestMaxLength'), scoreOnFetch: b('scoreOnFetch'), rescoreMissing: b('rescoreMissing'), hourlyBrief: b('hourlyBrief'), retentionDays: num('retentionDays'), pruneLowQuality: b('pruneLowQuality'), storeMaxItems: num('storeMaxItems') }; return Object.values(o).some((v) => v !== undefined) ? o : undefined; })(),
        fontSize: (() => { const f = (typeof r.fontSize === 'object' && r.fontSize !== null ? r.fontSize : {}); const num = (k) => typeof f[k] === 'number' && Number.isFinite(f[k]) ? Math.min(2, Math.max(0.5, Math.round(f[k] * 100) / 100)) : undefined; const o = { global: num('global'), items: num('items'), digest: num('digest'), hourly: num('hourly'), topics: num('topics') }; return Object.values(o).some((v) => v !== undefined) ? o : undefined; })(),
        wide: (() => { const w = (typeof r.wide === 'object' && r.wide !== null ? r.wide : {}); const b = (k) => typeof w[k] === 'boolean' ? w[k] : undefined; const o = { items: b('items'), digest: b('digest') }; return Object.values(o).some((v) => v !== undefined) ? o : undefined; })(),
        llmConcurrency: typeof r.llmConcurrency === 'number' && Number.isFinite(r.llmConcurrency) ? Math.min(8, Math.max(1, Math.floor(r.llmConcurrency))) : undefined,
        contentBlocklist: (() => { const seen = new Set(); const out = []; for (const s of strListOf(r.contentBlocklist)) {
            const t = s.trim().slice(0, 300);
            if (t && !seen.has(t)) {
                seen.add(t);
                out.push(t);
            }
        } return out.length ? out.slice(0, 2000) : undefined; })(),
        stubLimits: (() => { const s = (typeof r.stubLimits === 'object' && r.stubLimits !== null ? r.stubLimits : {}); const num = (k) => typeof s[k] === 'number' && Number.isFinite(s[k]) ? Math.min(500, Math.max(1, Math.floor(s[k]))) : undefined; const o = { zh: num('zh'), en: num('en') }; return Object.values(o).some((v) => v !== undefined) ? o : undefined; })(),
        tokenPrice: (() => {
            const t = (typeof r.tokenPrice === 'object' && r.tokenPrice !== null ? r.tokenPrice : {});
            const pair = (v) => { const p = (typeof v === 'object' && v !== null ? v : {}); const n = (k) => typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0 ? p[k] : undefined; const i = n('in'), o = n('out'), c = n('cached'); return i !== undefined || o !== undefined || c !== undefined ? { in: i ?? 0, out: o ?? 0, ...(c !== undefined ? { cached: c } : {}) } : undefined; };
            const d = pair(t.digest), tr = pair(t.translate);
            return d || tr ? { ...(d ? { digest: d } : {}), ...(tr ? { translate: tr } : {}) } : undefined;
        })(),
        peak: (() => {
            const p = (typeof r.peak === 'object' && r.peak !== null ? r.peak : {});
            const t = (v) => typeof v === 'string' && TIME_RE.test(v.trim()) ? v.trim() : undefined;
            const start = t(p.start), end = t(p.end);
            const o = { enabled: p.enabled === true, ...(start ? { start } : {}), ...(end ? { end } : {}), brief: p.brief === true };
            return o.enabled || start || end || o.brief ? o : undefined;
        })(),
    };
}
/** prefs.json 的内存门面：load 一次，get() 取当前值，set/save 持久化。 */
export class PrefsStore {
    path;
    prefs;
    log;
    constructor(path, log = noopLog) {
        this.path = path;
        this.log = log;
        this.prefs = { ...EMPTY_PREFS, tuningHistory: [] };
    }
    load() {
        if (!existsSync(this.path))
            return;
        try {
            this.prefs = normalizePrefs(JSON.parse(readFileSync(this.path, 'utf8')));
        }
        catch (e) {
            this.log.warn(`prefs at ${this.path} unreadable; using defaults (${String(e)})`);
        }
    }
    get() {
        return this.prefs;
    }
    /** 覆盖写（原子 tmp+rename）。 */
    save(next) {
        if (next)
            this.prefs = normalizePrefs({ ...this.prefs, ...next });
        mkdirSync(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.prefs, null, 2), 'utf8');
        renameSync(tmp, this.path);
    }
    /** 追加一条调教历史并立即生效一组权重改动（M5 用）。 */
    applyTune(text, actions, patch) {
        this.prefs = normalizePrefs({
            ...this.prefs,
            ...patch,
            tuningHistory: [...(this.prefs.tuningHistory ?? []), { at: new Date().toISOString(), text, actions }],
        });
        this.save();
    }
}
//# sourceMappingURL=prefs.js.map