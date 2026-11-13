/**
 * dsh-rss-news-daily 插件入口。
 *
 * 契约（cordis bundle）：
 *  - name    'rss-news-daily'（cordis.patch.yml 里 id 必须一致）
 *  - inject  ['timer','tools']（静态依赖；webServer/llm 为可选能力走 ctx.inject）
 *  - Config  Schemastery schema（src/config.ts）
 *  - apply   挂载点：store → fetcher → tools → scheduler
 *
 * 会话零注入：apply 只注册工具/定时器/路由，不写 systemPrompt、不发 followup。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Config } from './config.js';
import { Store } from './core/store.js';
import { PrefsStore } from './core/prefs.js';
import { createFetcher } from './core/fetcher.js';
import { effectiveSources, runFetchCycle, addSource, previewSource, removeSource, restoreBuiltinSource, setSourceEnabled, setSourceSummarize, updateSource, importOpml, exportOpml } from './service.js';
import { startScheduler } from './scheduler.js';
import { registerTools } from './tools.js';
import { runDailyDigest, scoreNewItems, appendHourlyBrief, textLooksForeign, zhTitleOf } from './digest-pipeline.js';
import { DshLlmClient, llmCallAvgMs, llmQueueSnapshot, setDevLogDir, setDevLogEnabled, setLlmConcurrency, setLlmDiagFile, setLoopGuardEnabled } from './dsh-llm.js';
import { inBlocklist, isShortLead, leadKey, truncateCodePoints } from './core/parser.js';
import { listTopics, newTopicId, queryTopicCandidates, runTopicPipeline, topicKeyOf, upsertTopicMeta } from './topic-pipeline.js';
import { mountApi } from './api.js';
import { parseTune } from './core/tune.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { digestFileName } from './digest.js';
import { applyPendingRestore, backupDirOf, runBackupZip } from './backup.js';
import { desktopNotify } from './notify.js';
import { normalizeUrl } from './service.js';
import { learnFromFeedback } from './core/tune.js';
import { zonedDayKey, zonedDayBounds } from './core/time.js';
import { probeSqlite, SqliteStore } from './core/sqlite-store.js';
import { addTokenStats } from './core/token-stats.js';
export { Config };
export const name = 'rss-news-daily';
/** 静态依赖：定时调度与模型工具——缺了核心不成立。
 *  webServer/llm 走 ctx.inject 可选声明（无 webServer 的 headless profile 也要能加载）。 */
export const inject = ['timer', 'tools'];
function loadBuiltinSources() {
    const file = join(fileURLToPath(new URL('.', import.meta.url)), 'sources.builtin.json');
    return JSON.parse(readFileSync(file, 'utf8'));
}
function resolveDataDir(configured) {
    if (configured)
        return configured;
    const home = process.env.DSH_HOME;
    if (home)
        return join(home, 'data', 'rss-news-daily');
    return join(process.env.HOME || '.', '.dsh', 'rss-news-daily');
}
export function apply(ctx, config) {
    const log = ctx.logger('rss-news-daily');
    if (!config.enabled) {
        log.info('disabled by config; loaded inert');
        return;
    }
    const dataDir = resolveDataDir(config.dataDir);
    setLlmDiagFile(join(dataDir, 'llm.log')); // LLM 每次调用落一行：死循环/空回复排查证据
    setLoopGuardEnabled(() => prefs.get().loopGuard !== false); // 用户显式关才停；装了 loop-recover 默认开
    const devlogDir = join(dataDir, 'devlog');
    setDevLogDir(devlogDir); // 完整 prompt/response 只在 prefs.devLog 开启时写
    setDevLogEnabled(() => prefs.get().devLog === true);
    setLlmConcurrency(() => prefs.get().llmConcurrency ?? 1); // 全局 AI 并发：默认 1 全串行，改设置即生效
    const probe = probeSqlite();
    if (!probe.ok)
        throw new Error('node:sqlite unavailable in this host (requires Node >=22.5)');
    if (!probe.fts)
        log.warn('SQLite FTS5/trigram unavailable in this host; search falls back to LIKE');
    applyPendingRestore(dataDir, log); // 上次请求过恢复：开库前整体覆盖写回
    const store = new SqliteStore({
        path: join(dataDir, 'store.db'), maxItems: () => prefs.get().digestOpts?.storeMaxItems ?? config.fetch.maxStoredItems, log,
        retentionDays: () => prefs.get().digestOpts?.retentionDays ?? 90,
        pruneLowQuality: () => prefs.get().digestOpts?.pruneLowQuality ?? true,
        fts: probe.fts,
    });
    const prefs = new PrefsStore(join(dataDir, 'prefs.json'), log);
    const fetcher = createFetcher({
        proxyUrl: () => prefs.get().proxyUrl || config.fetch.proxyUrl,
        timeoutMs: config.fetch.requestTimeoutMs,
        sizeLimitBytes: config.fetch.sizeLimitBytes,
        retries: config.fetch.retries,
    });
    const sources = effectiveSources(config.sources, store);
    const enabledCount = sources.filter((s) => s.enabled).length;
    let fetchProg = { running: false, done: 0, total: 0, stage: '', current: '' };
    let digestProg = { running: false, done: 0, total: 0, stage: '' };
    // ---- 进度 ETA：优先本轮实测速率（自动吸收并发/排队），冷启动退 purpose EMA；非 LLM 阶段无兜底只认实测 ----
    const etaClock = new Map();
    const progressEta = (key, p, opts = {}) => {
        if (!p.running || !p.total) {
            etaClock.delete(key);
            return undefined;
        }
        let cur = etaClock.get(key);
        if (!cur || cur.stage !== p.stage)
            etaClock.set(key, (cur = { stage: p.stage, t0: Date.now(), done0: p.done }));
        const made = p.done - cur.done0; // 本阶段内已完成的单位数
        const left = Math.max(0, p.total - p.done);
        const tail = opts.tail?.() ?? 0;
        if (made >= 1)
            return Math.max(0, Math.round(left * ((Date.now() - cur.t0) / made) + tail));
        if (opts.purpose === null)
            return tail > 0 ? Math.round(tail) : undefined;
        const avg = opts.purpose ? llmCallAvgMs(opts.purpose) : llmCallAvgMs();
        return avg == null ? (tail > 0 ? Math.round(tail) : undefined) : Math.round(left * avg + tail);
    };
    const FETCH_STAGE_PURPOSE = { fetch: null, score: 'score', judge: 'judge', translate: 'translate' }; // fetch 是网络抓取：非 LLM 阶段不给模型均值兜底
    const fetchEta = () => progressEta('fetch', fetchProg, { purpose: FETCH_STAGE_PURPOSE[fetchProg.stage] ?? null });
    const digestEta = () => progressEta('digest', digestProg, digestProg.stage === 'finishing'
        ? { purpose: null, tail: () => llmCallAvgMs('digest-prose') ?? llmCallAvgMs() ?? 0 }
        : { purpose: digestProg.stage === 'translate' ? 'translate' : 'item-summary' });
    const topicTailEst = () => (llmCallAvgMs('topic-merge') ?? llmCallAvgMs() ?? 0) + (llmCallAvgMs('topic-title') ?? 0);
    const topicEta = () => progressEta('topic', topicProg, topicProg.stage === 'chunks'
        ? { purpose: 'topic-chunk', tail: topicTailEst }
        : { purpose: null, tail: topicTailEst });
    // ---- LLM 队列归属：三条管线各自的客户端 tag 集合——进度端据此显示「排队等待中」而非干等 ----
    const FETCH_QUEUE_TAGS = ['brief', 'brief-translate', 'score', 'stub-judge', 'translate', 'classify'];
    const DIGEST_QUEUE_TAGS = ['digest', 'digest-translate'];
    const TOPIC_QUEUE_TAGS = ['topic'];
    let topicProg = { running: false, done: 0, total: 0, stage: '', id: '' };
    let fetchAbort;
    let fetchCancelled = false; // 「停止」请求标记：进度接口透出，前端区分"已取消"与"已完成"
    let digestCancelled = false;
    log.info(`loaded: ${sources.length} sources (${enabledCount} enabled) digestItems=${config.digest.digestItems} `
        + `dailyTime=${config.dailyTime} tz=${config.timezone || 'host-local'} dataDir=${dataDir}`);
    const makeFetchOpts = (sources) => ({
        fetch: fetcher,
        store,
        onSourceStart: (src) => { fetchProg.current = src.url; },
        onSourceDone: () => { fetchProg.done += 1; },
        sources: sources ?? effectiveSources(config.sources, store), // 每轮重取：用户改源/健康度实时生效
        maxItemsPerSource: config.fetch.maxItemsPerSource,
        storeContentChars: config.fetch.storeContentChars,
        concurrency: config.fetch.concurrency,
        dedupeThreshold: config.dedupe.threshold,
        dedupeWindowDays: config.dedupe.windowDays,
        log,
    });
    // token 用量分账：把 client.usage 累计进 meta.tokenStats（按日+按功能，实现在 core/token-stats）
    const addTokens = (feature, usage) => addTokenStats(store.meta, feature, usage, zonedDayKey(new Date(), config.timezone || undefined));
    // P1+P8：评分+快报——fetch 完成后 fire-and-forget（调度/手动路径共用，不阻塞 fetch 返回）
    let scoringInFlight = false; // 闩锁：与 digest rescoreMissing 互斥，防同批双评
    const dbgScore = (phase, extra) => {
        try {
            writeFileSync(join(dataDir, 'score-debug.json'), JSON.stringify({
                at: new Date().toISOString(), phase, scoringInFlight, ...extra,
            }, null, 1));
        }
        catch { /* 调试写盘失败不影响主流程 */ }
    };
    const briefEnabled = (dopts) => dopts?.hourlyBrief ?? config.fetch.hourlyBrief;
    // 桌面通知的点击目标：desktop 走 dsh://open 深链唤起主窗口（pending-view.json
    // 让 client.js 自动切到快报视图）；web 走浏览器直达阅读器 ?kind=hourly；
    // headless（无 webServer）只有通知没有点击。
    // desktop 判别：桌面版宿主由 Electron main 以 ELECTRON_RUN_AS_NODE=1 + ipc
    // spawn 拉起（dsh-desktop-host）；`dsh web`/CLI 两者皆无 → 浏览器直达。
    let wsGetOrigin;
    const isDesktopHost = () => process.env.ELECTRON_RUN_AS_NODE === '1' || process.connected === true;
    const pendingViewFile = join(dataDir, 'pending-view.json');
    const notifyBrief = (hm, brief) => {
        if (!prefs.get().notifyDesktop)
            return;
        let click = {};
        if (isDesktopHost()) {
            // pending-view.json 由 helper 在「点击时」写——通知弹出只展示，
            // 真点下去才让 client.js 切快报视图，不打断用户当前操作。
            click = { url: 'dsh://open', flagFile: pendingViewFile };
        }
        else {
            try {
                const o = wsGetOrigin?.();
                if (o)
                    click = { url: `${o.replace(/\/+$/, '')}/dsh-rss-news-daily/?kind=hourly` };
            }
            catch { /* 未 listen 则无点击 */ }
        }
        desktopNotify(`📰 ${hm} 时段快报`, brief.replace(/\s+/g, ' ').slice(0, 500), click);
    };
    const briefNow = async (fresh, signal) => {
        const now = new Date();
        const day = zonedDayKey(now, config.timezone || undefined);
        const hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone || undefined }).format(now);
        await appendHourlyBrief({
            items: fresh,
            sourcesById: new Map(effectiveSources(config.sources, store).map((src) => [src.id, { title: src.title }])),
            day, time: hm,
            minScore: config.fetch.hourlyMinScore,
            digestsDir: join(dataDir, 'digests'), log,
            llmClient: llmRuntime ? new DshLlmClient(llmRuntime, pickRoute(), log, 'brief') : undefined,
            translateClient: llmRuntime ? new DshLlmClient(llmRuntime, pickTranslateRoute(), log, 'brief-translate') : undefined,
            summaryConcurrency: prefs.get().digestOpts?.summaryConcurrency ?? config.summary.concurrency,
            signal,
            llmTimeoutMs: config.llm.timeoutMs,
            llmMaxTokens: config.llm.maxTokens,
            onBrief: (brief) => notifyBrief(hm, brief),
        });
    };
    const scoreAndBrief = async (cycleStart, signal) => {
        const dopts = prefs.get().digestOpts;
        const doScore = (dopts?.scoreOnFetch ?? config.fetch.scoreOnFetch) && config.llm.enabled && llmRuntime;
        const fresh = store.items.filter((i) => i.fetchedAt >= cycleStart);
        dbgScore('enter', { doScore, fresh: fresh.length, llmEnabled: config.llm.enabled, hasRuntime: !!llmRuntime });
        // 评分在跑不挡快报：用已评出的分照样追加一段（长评分窗口期快报不停更）
        if (scoringInFlight) {
            if (briefEnabled(dopts))
                await briefNow(fresh, signal);
            return;
        }
        if (!doScore)
            return;
        scoringInFlight = true;
        try {
            if (!signal?.aborted)
                fetchProg = { ...fetchProg, running: true, done: 0, total: fresh.length, stage: 'score', current: '' };
            const scoreClient = new DshLlmClient(llmRuntime, pickRoute(), log, 'score');
            let lastWarn = '';
            const slog = Object.create(log);
            slog.warn = (m) => { lastWarn = m; log.warn(m); };
            const scored = await scoreNewItems(fresh, scoreClient, {
                llmTimeoutMs: config.llm.timeoutMs,
                llmScoreCandidates: dopts?.llmScoreCandidates ?? config.digest.llmScoreCandidates,
                llmMaxTokens: config.llm.maxTokens,
                prefs: prefs.get(),
                signal,
                onScoreProgress: (done, total) => { fetchProg.done = done; fetchProg.total = total; },
            }, slog);
            dbgScore('scored', { scored, lastWarn });
            addTokens('score', scoreClient.usage);
            if (scored)
                await store.save();
            if (!signal?.aborted && briefEnabled(dopts))
                await briefNow(fresh, signal); // 取消后不再补写快报
            dbgScore('done', { scored });
        }
        catch (e) {
            dbgScore('error', { error: e instanceof Error ? e.message : String(e) });
            log.warn(`score-on-fetch failed (items kept unscored): ${e instanceof Error ? e.message : e}`);
        }
        finally {
            scoringInFlight = false;
        }
    };
    // 无效正文过滤：短正文（缺省 <15汉字/<10英文词，阈值 prefs.stubLimits 可调）先查 prefs.contentBlocklist
    // ——命中整条 hidden；未命中走一次翻译模型的 YES/NO 判定，无效则 stubLead（列表只显标题）并把正文追加进名单
    const judgeStubs = async (cycleStart, signal) => {
        const p = prefs.get();
        const zh = p.stubLimits?.zh ?? 15, en = p.stubLimits?.en ?? 10;
        const list = [...(p.contentBlocklist ?? [])];
        const fresh = store.items.filter((i) => i.fetchedAt >= cycleStart && !i.state.hidden);
        const pending = [];
        let dirty = false, added = false;
        for (const it of fresh) {
            const text = (it.summary || it.content || '').trim();
            if (!isShortLead(text, zh, en))
                continue;
            if (inBlocklist(text, list)) {
                it.state.hidden = true;
                dirty = true;
                continue;
            }
            if (!text) {
                it.state.stubLead = true;
                dirty = true;
                continue;
            } // 空正文：免判直接只显标题
            if (!it.state.stubLead)
                pending.push(it);
        }
        if (pending.length && llmRuntime) {
            // 按正文归一化分组：100 条同文只调一次 AI，结果套到全组（同题源的短正文完全一致）
            const groups = new Map();
            for (const it of pending) {
                const text = (it.summary || it.content || '').trim();
                const k = leadKey(text);
                if (k.length < 2) {
                    it.state.stubLead = true;
                    dirty = true;
                    continue;
                } // 归一化近空=无信息量，免判
                const g = groups.get(k) ?? { text: text.slice(0, 300), items: [] };
                g.items.push(it);
                groups.set(k, g);
            }
            if (!signal?.aborted && groups.size)
                fetchProg = { ...fetchProg, running: true, done: 0, total: groups.size, stage: 'judge', current: '' };
            const client = new DshLlmClient(llmRuntime, pickTranslateRoute(), log, 'stub-judge');
            for (const g of groups.values()) {
                if (signal?.aborted)
                    break;
                try {
                    const out = await client.generateText({
                        system: '判断给定"新闻正文"是否为无效内容——占位/引导/无实际信息的短文本（如"点击查看原文""视频请见原文""内容已被删除"），有实质摘要信息的判有效。只输出 YES（无效）或 NO（有效），不要解释。',
                        prompt: `正文：${g.text}`,
                        maxTokens: 256, // YES/NO 输出虽短，推理模型 reasoning 也要占预算
                        signal,
                        timeoutMs: config.llm.timeoutMs,
                        purpose: 'judge',
                    });
                    if (/\byes\b/i.test(out)) {
                        for (const it of g.items)
                            it.state.stubLead = true;
                        if (!inBlocklist(g.text, list)) {
                            list.push(g.text);
                            added = true;
                        }
                        dirty = true;
                    }
                }
                catch (e) {
                    if (signal?.aborted)
                        break;
                    log.warn(`stub-judge failed: ${String(e?.message || e)}`);
                }
                fetchProg.done += 1;
            }
        }
        if (added)
            prefs.save({ contentBlocklist: list });
        if (dirty)
            await store.save();
    };
    // autoTranslate：本轮新入库外文条目逐条翻译（手动+定时两路径共用）
    const translateFresh = async (cycleStart, signal) => {
        if (!prefs.get().autoTranslate || !llmRuntime)
            return;
        const fresh = store.items.filter((i) => i.fetchedAt >= cycleStart && !i.state.hidden && !i.state.translation && !i.aiSummary && isForeign(i));
        // 历史失败重试：translationError 且未超次数的旧条目每轮捎带一批；限量防长尾占满抓取周期
        // 外文未翻全部进重试（早退轮次不打 error 标记的条目也会搁浅——不能只挑有 error 的）
        const backlog = store.items
            .filter((i) => i.fetchedAt < cycleStart && !i.state.hidden && !i.state.translation && !i.aiSummary
            && (i.state.translationRetries ?? 0) < 3 && isForeign(i))
            .slice(0, 50);
        const queue = [...fresh, ...backlog];
        if (queue.length && !signal?.aborted)
            fetchProg = { running: true, done: 0, total: queue.length, stage: 'translate', current: '' };
        let translated = 0;
        for (const it of queue) {
            if (signal?.aborted)
                break; // 抓取/翻译共用信号；取消后不再开始下一条
            try {
                await translateItemCore(it, signal);
            }
            catch (e) {
                if (signal?.aborted)
                    break;
                it.state.translationError = e instanceof Error ? e.message : String(e);
                it.state.translationRetries = (it.state.translationRetries ?? 0) + 1;
            }
            fetchProg.done += 1;
            translated += 1;
            if (fetchProg.done % 10 === 0)
                void store.save();
        }
        if (queue.length) {
            await store.save();
            log.info(`autoTranslate: ${translated}/${fresh.length} items translated`);
        }
    };
    // 定时备份：单文件 rss-backup-<stamp>.zip（store.db 快照 + digests/ + prefs.json）；超额删最旧
    const runBackup = async () => {
        const b = prefs.get().backup;
        if (!b?.dir)
            return '';
        const dest = await runBackupZip(dataDir, store, backupDirOf(b.dir), b.keep ?? 7);
        store.meta.lastBackupAt = new Date().toISOString();
        log.info(`backup done: ${dest}`);
        return dest;
    };
    const maybeBackup = async () => {
        const b = prefs.get().backup;
        if (!b?.enabled || !b.dir)
            return;
        const last = Date.parse(store.meta.lastBackupAt ?? '') || 0;
        const days = b.period === 'week' ? 7 : b.period === 'month' ? 30 : 1;
        if (Date.now() - last >= days * 86_400_000)
            await runBackup().catch((e) => log.warn(`backup failed: ${e}`));
    };
    const runFetchPool = (pool, force = false) => {
        const cycleStart = new Date().toISOString();
        store.meta.lastFetchStartedAt = cycleStart; // 本轮起点:「本次」实时计数以此为界
        const controller = new AbortController();
        fetchAbort = controller;
        fetchCancelled = false; // 新一轮清除上轮取消标记
        fetchProg = { running: true, done: 0, total: pool.filter((s) => s.enabled).length, stage: 'fetch', current: '' };
        return runFetchCycle({ ...makeFetchOpts(pool), force, signal: controller.signal })
            .then(async (result) => {
            await judgeStubs(cycleStart, controller.signal);
            await translateFresh(cycleStart, controller.signal);
            await scoreAndBrief(cycleStart, controller.signal); // 纳入生命周期：快报写完前 running 不置闲
            void maybeBackup();
            return result;
        })
            .finally(() => {
            if (fetchAbort === controller) {
                fetchProg = { running: false, done: 0, total: 0, stage: '', current: '' };
                fetchAbort = undefined;
            }
        });
    };
    const runFetch = () => runFetchPool(effectiveSources(config.sources, store));
    // 所有 LLM 调用必须带超时——本地模型半死（连接挂起不响应）会把 runFetchPool 永不 settle，
    // 调度 mkCycle 的 running 锁随之卡死，后续每轮定时抓取全部跳过（生产曾停摆 11 小时）。
    // 超时经 timeoutMs 字段由 client 在拿到并发槽位后按次生效——排队等锁不消耗超时预算。
    // 翻译核心：标签协议解析 → 统一存 '标题\n\n正文'；标签缺失回退原样
    const translateItemCore = async (item, signal) => {
        const client = new DshLlmClient(llmRuntime, pickTranslateRoute(), log, 'translate');
        const text = await client.generateText({
            system: '你是翻译助手。把给定新闻标题和摘要翻译成简体中文，严格按此格式输出两行：\n标题：<译题>\n正文：<译文>\n只输出译文，不要解释。',
            prompt: `标题：${item.title}\n\n正文：${item.summary || item.title}`,
            maxTokens: config.llm.maxTokens, // 推理模型 reasoning 计入输出预算——1200 曾被思考吃光产出空回复
            signal,
            timeoutMs: config.llm.timeoutMs,
            purpose: 'translate',
        });
        addTokens('translate', client.usage); // 每条独立 client——usage 即本条用量
        const m = text.match(/标题：\s*([^\n]+)\n+(?:[\s\S]*?)正文：\s*([\s\S]+)/);
        item.state.translation = m ? `${m[1].trim()}\n\n${m[2].trim()}` : text.trim();
        delete item.state.translationError; // 成功后清掉历史失败标记（换模型重试成功后不再误报失败）
    };
    // 只看标题判定：中文标题的条目不需要翻译——摘要里混英文（促销文案/型号名）
    // 不应把中文标题条目误判成外文送进翻译队列
    const isForeign = (i) => textLooksForeign(i.title);
    // LLM 自动分类：新加源时把频道标题+条目样本丢给翻译模型归到现有分类，不中返回空
    const CLASSIFY_CATS = ['AI', '科技', '国际', '开发', '科学', '财经', '产品', '社会·人文', '综合'];
    const classifyFeed = async (feed) => {
        if (!llmRuntime)
            return ''; // 惰性求值：函数体调用时才读 llmRuntime（声明在下方）
        const client = new DshLlmClient(llmRuntime, pickTranslateRoute(), log, 'classify');
        try {
            const text = await client.generateText({
                system: `把 RSS 源归类到这些分类之一：${CLASSIFY_CATS.join('、')}。只输出分类名，不要解释。`,
                prompt: `频道：${feed.title}\n\n条目：${feed.items.slice(0, 5).map((i) => i.title).join('；')}`,
                maxTokens: 256, // 分类输出虽短，推理模型 reasoning 也要占预算
                timeoutMs: config.llm.timeoutMs,
                purpose: 'classify',
            });
            return CLASSIFY_CATS.find((c) => text.trim().includes(c)) || '';
        }
        catch {
            return '';
        }
    };
    const runFetchForce = (force = false, onlyFailed = false, filter) => {
        // onlyFailed：只重试失败/冷却中的启用源（「重试全部失败源」按钮）；否则默认全量
        let pool = effectiveSources(config.sources, store);
        if (onlyFailed)
            pool = pool.filter((s) => s.enabled && (s.health.lastError || (s.health.cooldownUntil && new Date(s.health.cooldownUntil).getTime() > Date.now())));
        // 界面筛选联动：选了源只抓该源，选了分类只抓该分类下所有源
        if (filter?.source)
            pool = pool.filter((s) => s.id === filter.source || s.url === filter.source);
        else if (filter?.category)
            pool = pool.filter((s) => s.category === filter.category);
        return runFetchPool(pool, force); // 手动抓取与定时/源重试共用进度、取消、翻译和评分流程
    }; // svc/api：手动抓取可带 force 绕冷却
    const runFetchFor = (sources) => {
        return runFetchPool(sources);
    };
    // 对外操作门面：tools（M2）与 HTTP API（M4）共用同一组语义
    const svc = {
        listSources: () => effectiveSources(config.sources, store),
        addSource: (o) => addSource(fetcher, store, o, o.category ? undefined : classifyFeed),
        previewSource: (o) => previewSource(fetcher, store, o, o.category ? undefined : classifyFeed),
        setEnabled: (id, en) => setSourceEnabled(store, id, en),
        setSummarize: (id, s) => {
            const cur = effectiveSources(config.sources, store).find((x) => x.id === normalizeUrl(id) || x.url === id);
            return setSourceSummarize(store, id, s, cur?.enabled ?? true);
        },
        removeSource: (id) => {
            const src = effectiveSources(config.sources, store).find((x) => x.url === id || x.id === id || x.id === normalizeUrl(id));
            return removeSource(store, src?.url || id, src?.builtin === true);
        },
        restoreSource: (url) => restoreBuiltinSource(store, url),
        updateSource: (id, patch) => updateSource(store, id, patch),
        importOpml: (text) => importOpml(store, text, config.sources),
        exportOpml: () => exportOpml(store, config.sources),
        runFetch: runFetchForce,
        fetchProgress: async () => ({ ...fetchProg, cancelled: fetchCancelled, etaMs: fetchEta(), queue: llmQueueSnapshot(FETCH_QUEUE_TAGS) }),
        translateItem: async (id) => {
            const item = store.items.find((i) => i.id === id);
            if (!item)
                return { ok: false, error: 'item not found' };
            if (!llmRuntime)
                return { ok: false, error: 'LLM 不可用' };
            await translateItemCore(item);
            await store.save();
            return { ok: true, translation: item.state.translation };
        },
        digestProgress: async () => ({ ...digestProg, cancelled: digestCancelled, etaMs: digestEta(), queue: llmQueueSnapshot(DIGEST_QUEUE_TAGS) }),
        rescanStubContent: async () => {
            const p = prefs.get();
            const list = p.contentBlocklist ?? [];
            if (!list.length)
                return 0;
            const zh = p.stubLimits?.zh ?? 15, en = p.stubLimits?.en ?? 10;
            let n = 0;
            for (const it of store.items) {
                if (it.state.hidden)
                    continue;
                const text = (it.summary || it.content || '').trim();
                if (text && isShortLead(text, zh, en) && inBlocklist(text, list)) {
                    it.state.hidden = true;
                    n++;
                }
            }
            if (n) {
                await store.save();
                log.info(`stub rescan: ${n} items hidden by contentBlocklist`);
            }
            return n;
        },
        testFetch: async (url, proxy) => {
            const d = await fetcher(url, undefined, { proxy });
            return 'error' in d ? { error: d.error } : { status: d.status, body: d.body.slice(0, 600) };
        },
        cancelFetch: async () => { if (fetchAbort) {
            fetchAbort.abort();
            fetchCancelled = true;
        } return true; },
        tune: async (text) => {
            const r = parseTune(text, prefs.get());
            if (!r.ok)
                return { ok: false, actions: [], error: r.error };
            if (r.patch)
                prefs.applyTune(text, r.actions.map((a) => `${a.kind}:${a.target}`), r.patch);
            return { ok: true, actions: r.actions.map((a) => `${a.kind}:${a.target}${a.factor ? `×${a.factor}` : ''}`) };
        },
        getDigest: async (day) => {
            const d = day || zonedDayKey(new Date(), config.timezone || undefined);
            try {
                const markdown = await readFile(join(dataDir, 'digests', digestFileName(d, 'zh')), 'utf8');
                return { ok: true, day: d, markdown };
            }
            catch {
                return { ok: false, day: d, error: `no digest for ${d}` };
            }
        },
        regenDigest: async (force) => {
            const doc = await digestNow(force);
            return { ok: true, items: doc.itemCount, degraded: doc.degraded };
        },
        searchItems: (q, limit = 20) => {
            const needle = q.toLowerCase();
            return store.items
                .filter((i) => !i.state.hidden && `${i.title} ${i.summary}`.toLowerCase().includes(needle))
                .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
                .slice(0, Math.max(1, limit))
                .map((i) => ({ id: i.id, title: i.title, link: i.link, topic: i.topic, fetchedAt: i.fetchedAt, digestedDay: i.digestedDay }));
        },
        feedback: async (id, action) => {
            const item = store.items.find((i) => i.id === id);
            if (!item)
                return { ok: false, error: 'item not found' };
            switch (action) {
                case 'read':
                    item.state.read = true;
                    break;
                case 'unread':
                    item.state.read = false;
                    break;
                case 'like':
                    item.state.liked = 1;
                    break;
                case 'dislike':
                    item.state.liked = -1;
                    break;
                case 'unlike':
                    item.state.liked = 0;
                    break;
                case 'hide':
                    item.state.hidden = true;
                    break;
                case 'unhide':
                    item.state.hidden = false;
                    break;
                default: return { ok: false, error: `unknown action: ${action}` };
            }
            await store.save();
            if (action === 'like' || action === 'dislike') {
                const { patch, learned } = learnFromFeedback(prefs.get(), item, action);
                prefs.save(patch);
                return { ok: true, learned };
            }
            return { ok: true };
        },
        retrySource: async (urlOrId) => {
            const list = effectiveSources(config.sources, store);
            const nid = normalizeUrl(urlOrId);
            const src = list.find((s) => s.id === nid || s.url === urlOrId || s.id === urlOrId);
            if (!src)
                return false;
            const h = store.getHealth(src.id) ?? { ok: 0, fail: 0, avgMs: 0 };
            store.setHealth(src.id, { ok: h.ok, fail: h.fail, avgMs: h.avgMs, cooldownUntil: '', failStreak: 0, lastError: '' });
            // src.health 是 effectiveSources 拍的快照副本，setHealth 不回流——
            // 不同步的话 runFetchFor 的 inCooldown 过滤还会把这个源跳过（点了重试却抓不到）
            src.health = { ok: h.ok, fail: h.fail, avgMs: h.avgMs, cooldownUntil: '', failStreak: 0, lastError: '' };
            await store.save();
            // 清完锁立刻单抓这个源：后台跑（翻译+评分可能几分钟），PATCH 立即返回，
            // 前端走 /fetch-progress 轮询；健康度由 runFetchCycle 落库
            void runFetchFor([src]).catch((e) => log.warn(`retry fetch failed for ${src.id}: ${String(e)}`));
            return true;
        },
        stopDigest: async () => { if (digestAbort) {
            digestAbort.abort();
            digestCancelled = true;
        } return true; },
        // ---- AI 专题 ----
        previewTopic: async (params, page = 1, filterSourceId) => {
            const r = queryTopicCandidates(store, params, config.timezone || undefined);
            const byId = new Map(effectiveSources(config.sources, store).map((s) => [s.id, { title: s.title }]));
            const counts = new Map();
            for (const it of r.items)
                counts.set(it.sourceId, (counts.get(it.sourceId) || 0) + 1);
            const sources = [...counts.entries()].map(([id, count]) => ({ id, title: byId.get(id)?.title || id, count }))
                .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
            const filtered = filterSourceId ? r.items.filter((it) => it.sourceId === filterSourceId) : r.items;
            const pg = Math.max(1, Math.min(Math.ceil(page) || 1, Math.max(1, Math.ceil(filtered.length / 15))));
            return {
                hitCount: r.hitCount, dedupCount: r.dedupCount, capCount: r.items.length, filterCount: filtered.length,
                page: pg, pageCount: Math.max(1, Math.ceil(filtered.length / 15)), sources,
                items: filtered.slice((pg - 1) * 15, pg * 15).map((it) => ({
                    id: it.id, title: zhTitleOf(it), link: it.link,
                    source: byId.get(it.sourceId)?.title || it.sourceId,
                    date: (it.publishedAt || it.fetchedAt || '').slice(0, 10),
                    score: Math.round(topicKeyOf(it) * 10) / 10,
                    dupCount: it.dupCount || 0,
                })),
            };
        },
        runTopic: async (params) => {
            const queued = topicBusy; // 在跑一个时新专题进内存队列（落 queued 元数据——列表可见+可取消，重启懒修复成 error）
            if (queued && topicQueue.length >= TOPIC_QUEUE_MAX)
                return { ok: false, error: `排队已满（${TOPIC_QUEUE_MAX}）` };
            const now = new Date().toISOString();
            const meta = {
                id: newTopicId(), title: truncateCodePoints(params.keywords.join('·'), 40) || '专题',
                keywords: params.keywords, from: params.from, to: params.to,
                sourceIds: params.sourceIds, focus: params.focus,
                minScore: params.minScore, maxItems: params.maxItems,
                createdAt: now, updatedAt: now,
                hitCount: 0, dedupCount: 0, itemCount: 0, usedCount: 0,
                durationMs: 0, degraded: false, excerpt: '', status: queued ? 'queued' : 'generating',
            };
            await upsertTopicMeta(join(dataDir, 'digests'), meta);
            if (queued)
                topicQueue.push(meta);
            else
                launchTopic(meta);
            return { ok: true, id: meta.id, queued };
        },
        regenTopic: async (id) => {
            const old = (await listTopics(join(dataDir, 'digests'), { queuedIds: topicQueue.map((m) => m.id) })).find((m) => m.id === id);
            if (!old)
                return { ok: false, error: 'not found' };
            if (old.status === 'generating' || old.status === 'queued')
                return { ok: false, error: '生成中/排队中不可重生成' };
            const queued = topicBusy;
            if (queued && topicQueue.length >= TOPIC_QUEUE_MAX)
                return { ok: false, error: `排队已满（${TOPIC_QUEUE_MAX}）` };
            const meta = {
                ...old, status: queued ? 'queued' : 'generating', error: undefined,
                hitCount: 0, dedupCount: 0, itemCount: 0, usedCount: 0,
                durationMs: 0, degraded: false, updatedAt: new Date().toISOString(),
            };
            await upsertTopicMeta(join(dataDir, 'digests'), meta);
            if (queued)
                topicQueue.push(meta);
            else
                launchTopic(meta);
            return { ok: true, id: meta.id, queued };
        },
        topicProgress: async () => ({ ...topicProg, etaMs: topicEta(), queue: llmQueueSnapshot(TOPIC_QUEUE_TAGS), queuedIds: topicQueue.map((m) => m.id) }),
        stopTopic: async (id) => {
            const qi = id ? topicQueue.findIndex((m) => m.id === id) : -1;
            if (qi >= 0) { // 排队中取消：撤队+落 error（与"手动停止"的在跑取消同构——都是用户主动终止）
                const meta = topicQueue.splice(qi, 1)[0];
                meta.status = 'error';
                meta.error = '排队中已取消';
                meta.updatedAt = new Date().toISOString();
                await upsertTopicMeta(join(dataDir, 'digests'), meta).catch(() => { });
                return { ok: true, cancelled: 'queued' };
            }
            if (topicAbort && (!id || id === topicProg.id)) {
                topicAbort.abort();
                return true;
            }
            if (topicProg.running) { // 无控制器却在"跑"＝发射台同步抛错残留：就地修复，否则该行永远挂 generating
                await listTopics(join(dataDir, 'digests')).catch(() => []); // 懒修复把非活跃 generating 落 error（含本条）
                topicProg = { running: false, done: 0, total: 0, stage: '', id: '' };
                topicBusy = false;
            }
            return true;
        },
        dequeueTopic: (id) => {
            const qi = topicQueue.findIndex((m) => m.id === id);
            if (qi >= 0) {
                topicQueue.splice(qi, 1);
                return true;
            }
            return false;
        },
        status: () => {
            const list = effectiveSources(config.sources, store);
            const failures = list.filter((s) => s.health.lastError).map((s) => ({ name: s.title, error: s.health.lastError }));
            return {
                sources: list.length,
                enabled: list.filter((s) => s.enabled).length,
                items: store.count?.() ?? store.items.length,
                todayAdded: (() => {
                    const t = new Date();
                    t.setHours(0, 0, 0, 0);
                    const qi = store.queryItems;
                    const b = zonedDayBounds(zonedDayKey(new Date(), config.timezone || undefined), config.timezone || undefined);
                    return qi ? qi.call(store, { day: 'x', fetchedAfter: b.after, fetchedBefore: b.before, pageSize: 1 }).total
                        : store.items.filter((i) => new Date(i.fetchedAt).getTime() >= t.getTime()).length;
                })(),
                lastAdded: (() => {
                    const since = store.meta.lastFetchStartedAt;
                    const qi = store.queryItems;
                    if (!qi || !since)
                        return store.meta.lastFetchAdded ?? 0;
                    return qi.call(store, { fetchedAfter: since, fetchedBefore: '9999-12-31', pageSize: 1 }).total;
                })(),
                todayTokens: (() => { const d = store.meta.tokenStats?.days?.[zonedDayKey(new Date(), config.timezone || undefined)]; return d ? { total: d.in + d.out, digest: d.digest, score: d.score, translate: d.translate, topic: d.topic ?? 0 } : undefined; })(),
                tokenStats: store.meta.tokenStats,
                version: (() => { try {
                    return JSON.parse(readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'package.json'), 'utf8')).version;
                }
                catch {
                    return undefined;
                } })(),
                lastFetchAt: store.meta.lastFetchAt,
                lastDigestDay: store.meta.lastDigestDay,
                failures,
                cooling: list.filter((s) => s.health.cooldownUntil && new Date(s.health.cooldownUntil).getTime() > Date.now()).length,
            };
        },
    };
    let llmRuntime;
    // 宿主目录选择服务（可选能力）：桌面端 = native 系统对话框；browse/无服务时 /api/pick-dir 降级
    let directoryPickerSvc;
    const pickRoute = () => {
        const ui = prefs.get().llm;
        if (ui?.provider && ui?.model)
            return ui; // UI 覆盖 > config 对 > 自动
        return { provider: config.llm.provider, model: config.llm.model };
    };
    const pickTranslateRoute = () => {
        const t = prefs.get().translateLlm;
        if (t?.provider && t?.model)
            return t; // 翻译模型覆盖 > 日报模型 > config
        return pickRoute();
    };
    let digestBusy = false; // 服务端防重入：调度与手动 /api/digest-run 并发会竞态落盘
    let digestAbort; // 「停止生成」：中止在飞的 LLM 调用（流逐条失败→降级收尾，不落半文件）
    let topicBusy = false; // 同时只跑一个专题；busy 时新建/重生成进内存队列，跑完自动排水
    let topicAbort;
    const topicQueue = []; // 排队中的专题（内存态；meta 已落 queued——重启后懒修复成 error）
    const TOPIC_QUEUE_MAX = 8;
    /** 在跑专题结束后排水：下一单 queued → generating 并发射（同步——.finally 与进度轮询间无窗口） */
    const drainTopicQueue = () => {
        const meta = topicQueue.shift();
        if (!meta)
            return;
        meta.status = 'generating';
        meta.updatedAt = new Date().toISOString();
        void upsertTopicMeta(join(dataDir, 'digests'), meta).catch(() => { });
        launchTopic(meta);
    };
    /** 专题 fire-and-forget 发射台：meta 已是 generating 落盘态；成功写 done，失败写 error 原因 */
    const launchTopic = (meta) => {
        const digestsDir = join(dataDir, 'digests');
        const controller = new AbortController();
        topicBusy = true;
        topicAbort = controller;
        topicProg = { running: true, done: 0, total: 0, stage: 'candidates', id: meta.id };
        try {
            const topicClient = llmRuntime ? new DshLlmClient(llmRuntime, pickRoute(), log, 'topic') : undefined;
            void runTopicPipeline({
                store,
                params: { keywords: meta.keywords, from: meta.from, to: meta.to, sourceIds: meta.sourceIds, focus: meta.focus, minScore: meta.minScore, maxItems: meta.maxItems },
                meta,
                llmClient: topicClient,
                llmEnabled: config.llm.enabled,
                summaryConcurrency: prefs.get().digestOpts?.summaryConcurrency ?? config.summary.concurrency,
                llmTimeoutMs: config.llm.timeoutMs,
                llmMaxTokens: config.llm.maxTokens,
                signal: controller.signal,
                sourcesById: new Map(effectiveSources(config.sources, store).map((s) => [s.id, { title: s.title }])),
                digestsDir,
                timezone: config.timezone,
                log,
                onProgress: (done, total, stage) => { topicProg.done = done; topicProg.total = total; topicProg.stage = stage; },
            }).then((m) => {
                addTokens('topic', topicClient?.usage);
                log.info(`topic generated: ${m.id} items=${m.itemCount} used=${m.usedCount} degraded=${m.degraded}`);
            }).catch((e) => {
                const reason = controller.signal.aborted ? '手动停止' : (e instanceof Error ? e.message : String(e));
                meta.status = 'error';
                meta.error = reason;
                meta.updatedAt = new Date().toISOString();
                void upsertTopicMeta(digestsDir, meta).catch(() => { });
                log.warn(`topic ${meta.id} failed: ${reason}`);
            }).finally(() => {
                topicBusy = false;
                topicAbort = undefined;
                topicProg = { running: false, done: 0, total: 0, stage: '', id: '' };
                drainTopicQueue(); // 排水：排队的下一个立即接棒（同 tick 重占 busy，进度轮询看不到空窗）
            });
        }
        catch (e) { // 同步抛出（pickRoute 配置错等）：不留 generating 死档/假活进度——懒修复豁免 activeId，丢了就没法救
            topicBusy = false;
            topicAbort = undefined;
            topicProg = { running: false, done: 0, total: 0, stage: '', id: '' };
            meta.status = 'error';
            meta.error = e instanceof Error ? e.message : String(e);
            meta.updatedAt = new Date().toISOString();
            void upsertTopicMeta(digestsDir, meta).catch(() => { });
            drainTopicQueue(); // 发射失败也要排水——队列不该被哑弹卡死
            throw e;
        }
    };
    const digestNow = (force = false, day) => {
        if (digestBusy)
            return Promise.resolve({ title: '', date: '', language: 'zh', markdown: '', itemCount: 0, itemIds: [], summarySource: 'extractive', degraded: true, note: 'digest already running' });
        digestBusy = true;
        digestAbort = new AbortController();
        digestCancelled = false; // 新一轮清除上轮取消标记
        digestProg = { running: true, done: 0, total: 0, stage: '' };
        return digestRun(force, day).then((doc) => { addTokens('digest', doc.tokens); return doc; })
            .finally(() => { digestBusy = false; digestAbort = undefined; digestProg = { running: false, done: 0, total: 0, stage: '' }; });
    };
    const digestRun = (force, day) => runDailyDigest({
        store,
        day,
        configSources: config.sources,
        // 每次 digest 现组 client：UI 换模型后下次立即生效（resolution 缓存在 client 实例上）
        llmClient: llmRuntime ? new DshLlmClient(llmRuntime, pickRoute(), log, 'digest') : undefined,
        translateClient: llmRuntime ? new DshLlmClient(llmRuntime, pickTranslateRoute(), log, 'digest-translate') : undefined,
        llmEnabled: config.llm.enabled,
        summaryEnabled: config.summary.enabled,
        summaryMaxItems: prefs.get().digestOpts?.summaryMaxItems ?? config.summary.maxItems,
        summaryConcurrency: prefs.get().digestOpts?.summaryConcurrency ?? config.summary.concurrency,
        summaryMaxLength: config.summary.maxLength,
        digestItems: prefs.get().digestOpts?.digestItems ?? config.digest.digestItems,
        perTopicLimit: prefs.get().digestOpts?.perTopicLimit ?? config.digest.perTopicLimit,
        llmScoreCandidates: prefs.get().digestOpts?.llmScoreCandidates ?? config.digest.llmScoreCandidates,
        subscribedTopics: prefs.get().subscribedTopics,
        rescoreMissing: !scoringInFlight && (prefs.get().digestOpts?.rescoreMissing ?? config.digest.rescoreMissing),
        minLlmScore: prefs.get().digestOpts?.minLlmScore ?? config.digest.minLlmScore,
        candidateHours: prefs.get().digestOpts?.candidateHours ?? undefined,
        dedupeStories: config.digest.dedupeStories,
        categoryPrompts: config.digest.categoryPrompts,
        digestMaxLength: prefs.get().digestOpts?.digestMaxLength ?? config.digest.maxLength,
        llmTimeoutMs: config.llm.timeoutMs,
        signal: digestAbort?.signal,
        onItemDone: (done, total, stage) => { digestProg.done = done; digestProg.total = total; digestProg.stage = stage || ''; },
        llmMaxTokens: config.llm.maxTokens,
        language: 'zh',
        timezone: config.timezone,
        digestsDir: join(dataDir, 'digests'),
        prefs: prefs.get(), // 每次取当前值：M5 调教立即生效于下一次打分
        penaltyWindowDays: config.dedupe.windowDays,
        force,
        log,
    }).then((doc) => {
        log.info(`digest written: ${doc.date} ${doc.itemCount} items degraded=${doc.degraded}`);
        // macOS 通知（可选，fire-and-forget，失败静默——通知是锦上添花不是关键路径）
        if (config.notifyEnabled) {
            const top = store.items.filter((i) => doc.itemIds.includes(i.id)).slice(0, config.notifyMaxTitles)
                .map((i) => i.title).join('；');
            execFile('osascript', ['-e',
                `display notification ${JSON.stringify(`${doc.itemCount} 条精选 ${top.slice(0, 120)}`)} with title ${JSON.stringify(doc.title)}`], () => { });
        }
        return doc;
    });
    let disposed = false;
    const disposers = [];
    void store.load()
        .then(() => {
        if (disposed)
            return;
        prefs.load();
        // loopGuard 首装一次性定型：此刻装了 loop-recover→勾，没装→不勾并落盘；
        // 此后不跟随安装状态变——之后装了也要用户手动开
        if (prefs.get().loopGuard === undefined) {
            const nm = dirname(fileURLToPath(new URL('../', import.meta.url)));
            const installed = existsSync(join(nm, 'dsh-loop-recover', 'package.json'));
            prefs.save({ loopGuard: installed });
            log.info(`loopGuard initialized: ${installed ? 'on (dsh-loop-recover installed)' : 'off (not installed)'}`);
        }
        disposers.push(registerTools(ctx, svc));
        disposers.push(startScheduler(ctx, {
            fetch: {
                ...config.fetch,
                intervalMinutes: prefs.get().schedule?.intervalMinutes ?? config.fetch.intervalMinutes,
                onStartup: prefs.get().schedule?.onStartup ?? config.fetch.onStartup,
            },
            dailyTime: config.dailyTime,
            getSchedule: () => prefs.get().schedule ?? {
                digestTimes: config.schedule.digestTimes.length ? config.schedule.digestTimes : [config.dailyTime],
                fetchTimes: config.schedule.fetchTimes,
            },
            timezone: config.timezone,
            catchUpHours: config.catchUpHours,
            enabled: true,
            lastDigestDay: () => store.meta.lastDigestDay,
            runFetchCycle: runFetch,
            runDailyDigest: digestNow,
            log,
        }));
        log.info('tools registered, scheduler armed');
    })
        .catch((e) => log.error('store load failed; plugin degraded to inert', e));
    // 可选能力按服务逐项声明：有就用、没有就降级，绝不因缺服务而拒载。
    ctx.inject(['llm'], (c) => {
        const runtime = c.llm;
        if (runtime) {
            llmRuntime = runtime;
            log.info('llm service available: LLM summaries enabled');
        }
    });
    ctx.inject(['directoryPicker'], (c) => {
        directoryPickerSvc = c.directoryPicker;
        if (directoryPickerSvc)
            log.info(`directoryPicker service available: ${directoryPickerSvc.capability?.().kind ?? 'unknown'}`);
    });
    ctx.inject(['webServer'], (c) => {
        const ws = c.webServer;
        if (ws) {
            wsGetOrigin = typeof ws.getOrigin === 'function' ? () => ws.getOrigin() : undefined;
            disposers.push(mountApi(ws, {
                store,
                prefs,
                svc,
                configSources: config.sources,
                timezone: config.timezone,
                readerPageSize: config.readerPageSize,
                digestsDir: join(dataDir, 'digests'),
                runDigest: digestNow,
                getLlm: () => llmRuntime,
                getDirectoryPicker: () => directoryPickerSvc,
                configLlm: { provider: config.llm.provider, model: config.llm.model },
                configSchedule: {
                    digestTimes: config.schedule.digestTimes.length ? config.schedule.digestTimes : [config.dailyTime],
                    fetchTimes: config.schedule.fetchTimes,
                },
                devlogDir,
            }));
            log.info('reader mounted at /dsh-rss-news-daily/');
        }
    });
    // apply 返回值即 cordis 插件 disposer：卸载时停调度、反注册工具。
    return () => {
        disposed = true;
        for (const d of disposers.splice(0)) {
            try {
                d();
            }
            catch { /* 清理失败不拖垮卸载 */ }
        }
    };
}
//# sourceMappingURL=index.js.map