/* dsh-rss-news-daily 阅读器（零构建，原生 JS）。全部数据走 /dsh-rss-news-daily/api/* */
const API = '/dsh-rss-news-daily/api'

// 主题跟随宿主：?theme= 管首屏不闪，postMessage 管之后明暗切换不重载
const applyTheme = (t) => { if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t }
applyTheme(new URLSearchParams(location.search).get('theme'))
window.addEventListener('message', (e) => { if (e.data && e.data.type === 'rnd-theme') applyTheme(e.data.theme) })
// 宿主跳转指令（通知点击→client.js postMessage）：切到每日精选页并按指定 kind 展示
window.addEventListener('message', (e) => {
  const d = e && e.data
  if (!d || d.type !== 'rnd-view') return
  state.digestKind = d.kind === 'hourly' ? 'hourly' : 'digest'
  state.kindPinned = true // 宿主显式指定 kind——loadDigest 不做同类回退
  document.querySelector('.tab[data-tab="digest"]')?.click()
})

const state = { page: 1, items: [], sources: [], prefs: null, peak: null, tab: 'items', digestDay: '', digestKind: ({ hourly: 'hourly', topics: 'topics' })[new URLSearchParams(location.search).get('kind')] || 'digest', kindPinned: !!new URLSearchParams(location.search).get('kind'), generating: false, topicView: 'list', topicId: '', topicBusy: false, sort: 'published', total: 0, pageSize: 50, daySetOn: '', dayPicked: '', archiveYears: [], forceArchive: sessionStorage.getItem('rnd-force-archive') === '1', briefSel: 'all', briefTypes: [] }
const $ = (sel) => document.querySelector(sel)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
/** 输出链接白名单：只放行 http(s)，javascript:/data: 一律清空 */
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '')

async function api(path, opts) {
  const res = await fetch(`${API}${path}`, opts)
  if (!res.ok) {
    // 带上后端返回的具体错误（如"已存在该源"），不再只显示干巴巴的状态码
    let msg = `HTTP ${res.status}`
    try { const j = await res.json(); if (j?.error) msg = String(j.error) } catch { /* 无 JSON 体按状态码报 */ }
    throw new Error(msg)
  }
  return res.json()
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function toast(msg) {
  const el = $('#toastbar')
  el.textContent = msg
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { el.textContent = ''; loadStatus() }, 3000)
}

// 用户真实活跃信号：只认手势（移动/按键/点按/滚动/触屏）——自动轮询不算"在用"；
// 打开页面本身、从隐藏切回可见各算一次。status 轮询捎带 act=1，不增请求。
let lastGestureAt = Date.now()
for (const ev of ['mousemove', 'keydown', 'pointerdown', 'scroll', 'touchstart'])
  document.addEventListener(ev, () => { lastGestureAt = Date.now() }, { passive: true, capture: true })
document.addEventListener('visibilitychange', () => { if (!document.hidden) lastGestureAt = Date.now() })
const userActive = () => !document.hidden && Date.now() - lastGestureAt < 60_000

async function loadStatus() {
  try {
    const s = await api(`/status${userActive() ? '?act=1' : ''}`)
    state.peak = s.peak || null
    $('#statusbar').textContent = `${s.enabled}/${s.sources} 源 · 今日+${s.todayAdded ?? 0} · 本次+${s.lastAdded ?? 0} · 共${s.items} 条 · ${s.failures?.length ? `${s.failures.length} 源异常${s.cooling ? `（${s.cooling} 冷却中）` : ''}` : '健康'}${s.peak?.active ? ' · ⏸高峰中·AI暂停' : ''}${s.peak?.defer ? ' · 欠账待补' : ''}`
    renderPeakInfo()
  } catch { $('#statusbar').textContent = '状态不可用' }
}
// 设置页「高峰时段暂停」状态行：当前峰/谷 + 窗口 + 欠账
function renderPeakInfo() {
  const el = $('#peakInfo'); if (!el) return
  const p = state.peak
  el.textContent = !p?.enabled ? '' : p.active
    ? `当前：高峰中（窗口 ${p.start ?? ''}–${p.end ?? ''}）· ${p.brief ? 'AI 暂停·快报照常' : '只抓取不调 AI'}${p.defer ? ' · 有欠账待补' : ''}`
    : `当前：低峰中（高峰窗口 ${p.start ?? ''}–${p.end ?? ''}）`
}
// 高峰三选弹层：「仍然执行」→now（peakBypass 立即跑）；「排入低峰队列」→queue（任务挂起出峰自动跑）；「取消」→不发请求。非高峰直接 now
// 弹层单例：已开着再来第二个调用（双击/连点）直接 cancel——否则一次点击会同时兑现两个 promise 发重复请求
const askPeak = (what) => new Promise((resolve) => {
  if (!state.peak?.active) return resolve('now')
  const m = $('#peakModal')
  if (!m.hidden) return resolve('cancel')
  $('#peakMsg').textContent = `现在是高峰时段（${state.peak.start ?? ''}–${state.peak.end ?? ''}），AI 调用暂停、只抓取新闻。${what}可以仍然执行，也可以排入队列等低峰自动执行。`
  m.hidden = false
  const binds = []
  const done = (v) => { m.hidden = true; for (const [el, fn] of binds) el.removeEventListener('click', fn); resolve(v) }
  for (const [sel, v] of [['#btnPeakNow', 'now'], ['#btnPeakQueue', 'queue'], ['#btnPeakCancel', 'cancel']]) {
    const fn = () => done(v); $(sel).addEventListener('click', fn); binds.push([$(sel), fn])
  }
})

// ---- 阅读字号缩放：scope=items(全部新闻)/digest(日报)/hourly(快报)；存 prefs.fontSize 重启后仍生效 ----
// 分项值(items/digest/hourly)优先于设置页统一值(global)；设置页调整=整体覆盖 fontSize，分项被清除
const FZ = { MIN: 0.8, MAX: 1.6, STEP: 0.1 }
// feed description 常见"查看原文"类引导文案——后端入库已剥，这里再兜底存量数据
const LEAD_STUB = /(?:…|\.{2,})?\s*(?:点击\s*(?:查看|阅读|标题)?\s*(?:查看|阅读)?原文|阅读原文|阅读全文|点击阅读全文|点击查看全文|查看全文|点击阅读|阅读详细|阅读更多|查看更多|查看详情|详情请点击|点此查看全文|read(?:\s+the)?\s+full\s+(?:article|story|post|content)|continue\s+reading|read\s+more|view\s+original)\s*(?:[>》»→›↗]|\.{1,3})*/gi
const FZ_LABEL = { items: '全部新闻', digest: '日报', hourly: '快报', topics: '专题' }
const fzEff = (scope) => { const f = state.prefs?.fontSize || {}; return f[scope] ?? f.global ?? 1 }
const fzPct = (v) => `${Math.round(v * 100)}%`
function applyFontSize() {
  const st = document.documentElement.style
  for (const s of ['items', 'digest', 'hourly', 'topics']) st.setProperty(`--fz-${s}`, String(fzEff(s)))
  const f = state.prefs?.fontSize || {}
  if ($('#fzVal')) $('#fzVal').textContent = f.global != null ? fzPct(f.global) : (f.items != null || f.digest != null || f.hourly != null || f.topics != null ? '分项' : '100%')
  if ($('#fzScopes')) $('#fzScopes').textContent = `全部新闻 ${fzPct(fzEff('items'))} · 日报 ${fzPct(fzEff('digest'))} · 快报 ${fzPct(fzEff('hourly'))} · 专题 ${fzPct(fzEff('topics'))}`
}
async function saveFontSize(next) {
  try {
    const r = await post('/prefs', { fontSize: next })
    state.prefs = r.prefs || state.prefs
    // 旧后端（页面热更但插件未重启）白名单没有 fontSize——POST 被丢弃。本地先生效，并提示重启后才持久化
    const wanted = Object.values(next).some((v) => v !== undefined)
    const saved = r.prefs?.fontSize && Object.values(r.prefs.fontSize).some((v) => v !== undefined)
    if (wanted && !saved) {
      state.prefs = { ...(state.prefs || {}), fontSize: next }
      applyFontSize()
      toast('字号已生效；旧版后端未保存此项——重启 dsh 后才持久')
      return true
    }
    applyFontSize()
    return true
  } catch (e) { toast(`保存失败: ${e.message}`); return false }
}
const fzStep = async (scope, d) => { // 页内 A−A＋：基于该视图当前生效值步进，显式落该 scope（盖住 global）
  if (!state.prefs) await loadPrefs() // 点击可能早于 prefs 预载返回——先取再合并，防覆盖服务端已有值
  const v = Math.min(FZ.MAX, Math.max(FZ.MIN, Math.round((fzEff(scope) + d * FZ.STEP) * 10) / 10))
  saveFontSize({ ...(state.prefs?.fontSize || {}), [scope]: v }).then((ok) => ok && toast(`${FZ_LABEL[scope]}字号 ${fzPct(v)}`))
}
const fzGlobal = async (d) => { // 设置页统一调：整体覆盖 fontSize——之前各页的分项设置被清除
  if (!state.prefs) await loadPrefs() // 同上
  const v = Math.min(FZ.MAX, Math.max(FZ.MIN, Math.round(((state.prefs?.fontSize?.global ?? 1) + d * FZ.STEP) * 10) / 10))
  saveFontSize({ global: v }).then((ok) => ok && toast(`阅读字号统一为 ${fzPct(v)}`))
}
const fzCtl = (scope) => `<span class="fz-ctl"><button data-fz="${scope}" data-d="-1" title="缩小「${FZ_LABEL[scope]}」字号（重启后仍生效）">A−</button><button data-fz="${scope}" data-d="1" title="放大「${FZ_LABEL[scope]}」字号（重启后仍生效）">A＋</button></span>`

// ---- 适应宽屏：prefs.wide {items=全部新闻页, digest=每日精选页(日报/快报/专题共用)}；默认开（!==false），显式 false 才回窄版 ----
function applyWide() {
  const w = state.prefs?.wide || {}
  const wide = (state.tab === 'items' && w.items !== false) || (state.tab === 'digest' && w.digest !== false)
  const st = document.documentElement.style
  st.setProperty('--mainw', wide ? '1440px' : '880px')
  st.setProperty('--digestw', w.digest !== false ? '1180px' : '720px')
  st.setProperty('--topicw', w.digest !== false ? '1180px' : '760px')
  if ($('#wideItems')) $('#wideItems').checked = w.items !== false
  if ($('#wideDigest')) $('#wideDigest').checked = w.digest !== false
}
const saveWide = async (next) => {
  try {
    const r = await post('/prefs', { wide: next })
    state.prefs = r.prefs || state.prefs
    applyWide()
  } catch (e) { toast(`保存失败: ${e.message}`) }
}
for (const [id, key] of [['wideItems', 'items'], ['wideDigest', 'digest']]) {
  $(`#${id}`)?.addEventListener('change', async (e) => {
    if (!state.prefs) await loadPrefs()
    saveWide({ ...(state.prefs?.wide || {}), [key]: e.target.checked })
  })
}
$('#btnWideReset')?.addEventListener('click', () => saveWide({})) // 清空 → normalize 落 undefined → 全回默认窄版

// ---- 条目流 ----

async function loadItems() {
  const p = new URLSearchParams()
  if ($('#q').value) p.set('q', $('#q').value)
  if (/^\d{4}-\d{2}-\d{2}$/.test($('#day').value.trim())) p.set('day', $('#day').value.trim()) // 非 yyyy-mm-dd 不参与过滤
  if ($('#category').value) p.set('category', $('#category').value)
  if ($('#srcFilter').value) p.set('source', $('#srcFilter').value)
  if ($('#unread').checked) p.set('unread', '1')
  p.set('sort', state.sort)
  p.set('page', state.page)
  if (!state.items.length) $('#itemList').innerHTML = '<div class="skel"><div></div><div></div></div>'.repeat(3) // 骨架屏:仅空列表时,刷新不闪
  try {
    if (state.archive && !state.archYear) { // 无归档库——不发 year= 空请求，直接空态
      state.items = []; state.total = 0
      $('#itemList').innerHTML = '<p class="empty">暂无档案——清退的新闻会按年份归档到这里</p>'
      return
    }
    const r = state.archive
      ? await api(`/archive/items?year=${state.archYear}&${p}`)
      : await api(`/items?${p}`)
    state.items = r.items; state.total = r.totalPending ? -1 : r.total; state.pageSize = r.pageSize
    renderItems()
    // 冷启动预热期 COUNT 未算：首屏先出，后台补查总数（不闪骨架——items 已在）；限次防 warmup 异常时死循环
    if (r.totalPending && (state.totalRetry = (state.totalRetry || 0) + 1) <= 8) {
      clearTimeout(state.totalRetryT)
      state.totalRetryT = setTimeout(() => { if (state.total < 0) loadItems() }, 900)
    } else if (!r.totalPending) state.totalRetry = 0
  } catch (e) { $('#itemList').innerHTML = `<p class="err">加载失败: ${esc(e.message)}</p>` }
}
// 档案按钮可见性：无年库默认隐藏；彩蛋区开关经 sessionStorage 强显（本会话有效，重启即失效）
function updateArchiveBtn() {
  $('#btnArchive').hidden = !(state.forceArchive || (state.archiveYears || []).length)
}
api('/archive/list').then((r) => { state.archiveYears = r.archives || []; updateArchiveBtn() })
  .catch(() => { state.archiveYears = []; updateArchiveBtn() })
// 档案模式：切换年库只读视图（隐藏操作按钮、日期的unread 过滤无关但保留透传无妨）
async function toggleArchive(on) {
  state.archive = on
  $('#btnArchive').classList.toggle('active', on)
  $('#archYear').closest('label').hidden = !on
  $('#btnFetch').hidden = on
  $('#itemList').classList.toggle('archive', on)
  if (on && !$('#archYear').options.length) {
    try {
      const r = await api('/archive/list')
      $('#archYear').innerHTML = r.archives.map((a) => `<option value="${a.year}">${a.year} 年（${a.items} 条）</option>`).join('') || '<option value="">无档案</option>'
      if (r.archives[0]) state.archYear = r.archives[0].year
    } catch { $('#archYear').innerHTML = '<option value="">无档案</option>' }
  }
  state.page = 1; loadItems()
}

function renderItems() {
  const el = $('#itemList')
  if (!state.items.length) { el.innerHTML = '<p class="empty">没有条目</p>'; return }
  el.innerHTML = state.items.map(itemHtml).join('')
  const totalKnown = state.total >= 0 // -1=预热期 COUNT 未算：页码只出当前页，下一页按满页放行
  const totalPages = Math.max(1, Math.ceil(Math.max(0, state.total) / state.pageSize))
  $('#pageInfo').textContent = totalKnown ? `第 ${state.page} / ${totalPages} 页 · 共 ${state.total} 条` : `第 ${state.page} 页 · 共 …`
  $('#prevPage').disabled = state.page <= 1
  $('#nextPage').disabled = totalKnown ? !(state.page * state.pageSize < state.total) : state.items.length < state.pageSize
  $('#btnTopPage').hidden = state.page <= 1
}

// 阅读位置记忆：{page, id(锚点条目), top(视口内偏移)}——滚动节流保存，重开恢复并滚回该条目
const POS_KEY = 'rss_reader_pos'
function savePos() {
  for (const el of document.querySelectorAll('#itemList .item')) {
    const r = el.getBoundingClientRect()
    if (r.bottom > 90) { // 第一条可见条目做锚点（90≈sticky头+筛选栏高度）
      localStorage.setItem(POS_KEY, JSON.stringify({ page: state.page, id: el.dataset.id, top: r.top }))
      return
    }
  }
}
let posT = 0
window.addEventListener('scroll', () => { clearTimeout(posT); posT = setTimeout(savePos, 300) }, { passive: true })
function restorePos() {
  try { const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); return p && p.page > 1 ? p : null }
  catch { return null }
}
function scrollToAnchor(p) {
  const el = document.querySelector(`#itemList .item[data-id="${CSS.escape(p.id)}"]`)
  if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - p.top })
}
$('#btnTopPage').addEventListener('click', () => {
  localStorage.removeItem(POS_KEY)
  state.page = 1
  loadItems().then(() => window.scrollTo(0, 0))
})

// 分类→色相（字符串哈希稳定取色，卡片左色条按领域着色）
const topicHue = (t) => { let h = 0; for (const c of String(t || '综合')) h = (h * 31 + c.charCodeAt(0)) % 360; return h }
const scoreBadge = (i) => { const s = i.llmScore; if (typeof s !== 'number' || s <= 0) return ''; const cls = s >= 8 ? 's-hi' : s >= 5 ? 's-mid' : 's-lo'; return `<span class="score ${cls}" title="AI 评分 ${s}/10">${s}</span>` }

function itemHtml(i) {
    const st = i.state || {} // 老数据可能缺 state 字段——防御，防整个渲染挂掉（"翻页没反应"）
    return `
    <div class="item ${st.read ? 'read collapsed' : ''} ${st.liked === 1 ? 'liked' : ''}" data-id="${esc(i.id)}" style="--hue:${topicHue(i.topic)}">
      ${(() => { if (i.aiSummary || state.tlHidden?.has(i.id)) return ''; const t = (st.translation || '').trim(); const nl = t.indexOf('\n'); return t ? `<div class="item-tl">译: ${esc((nl > 0 ? t.slice(0, nl) : t).trim())}</div>` : '' })()}
      <div class="item-head">${scoreBadge(i)}
        <a class="tlink" data-id="${esc(i.id)}" href="${esc(safeUrl(i.link) || '#')}" target="_blank" rel="noopener">${esc(i.title)}</a>
      </div>
      <div class="item-meta"><b class="item-src" title="${esc(i.sourceId)}">${esc(state.sources?.find((x) => x.id === i.sourceId || x.url === i.sourceId)?.title || i.sourceId)}</b> · ${esc(i.topic)} · ${(() => { const d = new Date(i.publishedAt || i.fetchedAt); const p = (n) => String(n).padStart(2, '0'); return isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` })()}${fzCtl('items')}${i.digestedDay ? ' · 已入日报' : ''}${i.reasons?.length ? ` · <i>${esc(i.reasons.join('、'))}</i>` : ''}${(() => {
        if (i.aiSummary) return '' // 已有中文核心事实，不再提供翻译
        const t = i.title + (i.summary || '')
        const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length
        if (cjk * 2 > t.replace(/\s/g, '').length) return ''
        if (state.translating === i.id) return ' <button disabled title="翻译中">翻译中…</button>'
        if (st.translation) return ` <button data-act="translate" data-id="${esc(i.id)}" title="重新翻译">重译</button>${state.tlHidden?.has(i.id) ? ` <button data-act="showtl" data-id="${esc(i.id)}" title="显示译文">显示翻译</button>` : ` <button data-act="hidetl" data-id="${esc(i.id)}" title="隐藏译文">隐藏翻译</button>`}`
        return ` <button data-act="translate" data-id="${esc(i.id)}" title="翻译成中文">译</button>`
      })()}</div>
      ${(() => { if (st.stubLead) return ''; const lead = (i.aiSummary || i.summary || '').replace(LEAD_STUB, '').trim(); return lead ? `<div class="item-lead">${esc(lead.slice(0, 140))}</div>` : '' })()}
      ${(() => { if (st.stubLead || i.aiSummary || state.tlHidden?.has(i.id)) return ''; const t = (st.translation || '').trim(); const nl = t.indexOf('\n'); const body = nl > 0 ? t.slice(nl).replace(/\s+/g, ' ').trim() : t; return body && nl > 0 ? `<div class="item-lead item-tl-body">译: ${esc(body.slice(0, 240))}</div>` : '' })()}
      <div class="item-actions">
        <button data-act="${st.read ? 'unread' : 'read'}" data-id="${esc(i.id)}" title="${st.read ? '标为未读（展开简介）' : '标为已读（收起简介）'}">${st.read ? '◉' : '✓'}</button>
        <button data-act="${st.liked === 1 ? 'unlike' : 'like'}" data-id="${esc(i.id)}" title="推荐学习：以后多推同类">👍</button>
        <button data-act="dislike" data-id="${esc(i.id)}" title="少推学习：以后少推同类">👎</button>
        <button data-act="hide" data-id="${esc(i.id)}" title="从列表隐藏">✕</button>
        <button data-act="copy" data-id="${esc(i.id)}" data-link="${esc(safeUrl(i.link))}" title="复制链接">⧉</button>
      </div>
    </div>`
}

$('#itemList').addEventListener('click', async (e) => {
  const fz = e.target.closest('button[data-fz]') // 条目行右侧字号控件：缩放作用于整个「全部新闻」视图
  if (fz) { fzStep(fz.dataset.fz, +fz.dataset.d); return }
  const link = e.target.closest('a.tlink') // 点标题=标已读（不阻塞跳转）
  if (link) {
    const it = state.items.find((x) => x.id === link.dataset.id)
    if (it && !it.state.read) {
      it.state.read = true
      link.closest('.item')?.classList.add('read', 'collapsed')
      post('/feedback', { id: it.id, action: 'read' }).catch(() => {}) // 静默,失败不打扰
    }
  }
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  if (btn.dataset.act === 'copy') {
    try { await navigator.clipboard.writeText(btn.dataset.link || ''); toast('链接已复制') }
    catch { toast('复制失败') }
    return
  }
  if (btn.dataset.act === 'translate') {
    state.translating = btn.dataset.id; renderItems()
    let rr
    try { rr = await post('/feedback', { id: btn.dataset.id, action: 'translate' }); toast('已翻译') }
    catch (err) { toast(`翻译失败: ${err.message}`) }
    state.translating = null
    state.tlHidden?.delete(btn.dataset.id) // 重译成功自动取消隐藏，译文直接展示
    // 就地替换该条目 DOM——不重建整表，滚动位置不丢
    const it = state.items.find((x) => x.id === btn.dataset.id)
    const row = document.querySelector(`.item [data-id="${CSS.escape(btn.dataset.id)}"]`)?.closest('.item')
    if (it && row) { if (rr?.state) it.state = rr.state; row.outerHTML = itemHtml(it) }
    else loadItems()
    return
  }
  if (btn.dataset.act === 'hidetl') { (state.tlHidden ||= new Set()).add(btn.dataset.id); renderItems(); return }
  if (btn.dataset.act === 'showtl') { state.tlHidden?.delete(btn.dataset.id); renderItems(); return }
  try {
    await post('/feedback', { id: btn.dataset.id, action: btn.dataset.act })
    loadItems()
  } catch (err) { toast(`操作失败: ${err.message}`) }
})

for (const sel of ['#q', '#day', '#category', '#unread']) {
  $(sel).addEventListener('change', () => { state.page = 1; loadItems() })
}
// 源筛选联动：选了具体源后，分类只保留该源的分类（避免选出无交集组合）
$('#btnArchive').addEventListener('click', () => toggleArchive(!state.archive))
$('#archYear').addEventListener('change', () => { state.archYear = $('#archYear').value; state.page = 1; loadItems() })
$('#srcFilter').addEventListener('change', () => {
  const sel = $('#srcFilter').value
  const cats = sel ? [...new Set(state.sources.filter((s) => s.id === sel).map((s) => s.category).filter(Boolean))]
                   : [...new Set(state.sources.map((s) => s.category).filter(Boolean))]
  const cur = $('#category').value
  $('#category').innerHTML = '<option value="">全部分类</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('')
  if (cats.includes(cur)) $('#category').value = cur
  state.page = 1; loadItems()
})
$('#q').addEventListener('input', debounce(() => { state.page = 1; loadItems() }, 400))
$('#sortSel').addEventListener('change', (e) => { state.sort = e.target.value; state.page = 1; loadItems() })
// 翻页后滚回列表顶部（pager 在页脚，不滚会停在页底）
const toTop = () => window.scrollTo(0, 0)
$('#prevPage').addEventListener('click', () => { if (state.page > 1) { state.page--; loadItems().then(toTop) } })
$('#nextPage').addEventListener('click', () => { if (state.page * state.pageSize < state.total) { state.page++; loadItems().then(toTop) } })
let fetchPoll = 0
const fetchBtnIdle = () => { $('#btnFetch').textContent = '⟳ 抓取'; $('#btnFetch').disabled = false; if (fetchPoll) { clearInterval(fetchPoll); fetchPoll = 0 }; markFetchingSrc('') }
// 正在抓的源行高亮（订阅源列表里对应按钮变⏳）
const markFetchingSrc = (url) => {
  if ($('#tab-sources')?.hidden) return // 订阅源页不在前台不动 DOM
  document.querySelectorAll('#srcList button[data-src-act="retry"]').forEach((b) => {
    if (b.dataset.fetching === '1') { b.textContent = b.dataset.origText || '↻ 抓取'; delete b.dataset.fetching; delete b.dataset.origText }
  })
  if (!url) return
  const btn = document.querySelector(`#srcList button[data-src-act="retry"][data-id="${CSS.escape(url)}"]`)
  if (btn && btn.dataset.fetching !== '1') { btn.dataset.origText = btn.textContent; btn.dataset.fetching = '1'; btn.textContent = '⏳ 抓取中' }
}
// 抓取进度轮询：手动/定时/启动抓取统一显示
const startFetchPoll = () => {
  if (fetchPoll) return
  const b = $('#btnFetch')
  b.textContent = '⟳ 抓取中…'
  let tickN = 0
  fetchPoll = setInterval(async () => {
    try {
      const p = await api('/fetch-progress')
      if (p.running) {
        const st = p.cancelled ? '停止中' : stageZh(p.stage) || '抓取中'; b.textContent = `⏹ ${st}(${p.done}/${p.total}) 点我取消`; b.disabled = false; markFetchingSrc(p.current)
        if (++tickN % 3 === 0 && !$('#tab-items')?.hidden) { // ~2.4s 静默刷新列表：仅在阅读器页执行（隐藏tab锚点会滚到顶）
          savePos(); await loadItems()
          const p2 = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
          if (p2) scrollToAnchor(p2)
        }
      }
      else { fetchBtnIdle(); toast(p.cancelled ? '抓取已取消' : '抓取完成'); state.page = 1; state.sort = 'fetched'; $('#sortSel').value = 'fetched'; localStorage.removeItem(POS_KEY); loadItems(); loadStatus(); loadSources() }
    } catch { /* 进度不可达不阻塞 */ }
  }, 800)
}
$('#btnFetch').addEventListener('click', async () => {
  const b = $('#btnFetch')
  // 抓取中再点=取消
  try { const p = await api('/fetch-progress'); if (p.running) { await post('/fetch-cancel', {}); toast('已请求取消，在飞的源收尾后停止'); b.textContent = `⏹ 停止中(${p.done}/${p.total})`; b.disabled = true; return } } catch { /* 按未运行处理 */ }
  const src = $('#srcFilter').value, cat = $('#category').value
  startFetchPoll()
  try {
    await post('/fetch', { force: true, source: src || undefined, category: src ? undefined : (cat || undefined) })
  } catch (e) { toast(`抓取失败: ${e.message}`); fetchBtnIdle() }
})
// 周期性探测：打开面板后定时/启动抓取随时开始,5s一查,发现运行即接管（运行期靠 fetchPoll 自身轮询）
setInterval(() => { if (!fetchPoll) api('/fetch-progress').then((p) => { if (p.running) startFetchPoll() }).catch(() => {}) }, 5000)

// 停留每日精选期间：30s 一查所看日期的 digest 文件,内容变了就重渲（定时生成的新快报/新日报自动上屏）；专题页无日报文件语义，跳过
setInterval(() => {
  if ($('#tab-digest')?.hidden || state.generating || state.digestKind === 'topics') return
  const day = $('#digestDay').value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return
  api(state.digestKind === 'hourly' ? `/briefs?day=${day}&type=${encodeURIComponent(state.briefSel)}` : `/digest/${day}`)
    .then((r) => { if (r.markdown !== state.digestRendered) { loadDigest(); toast('内容已更新') } })
    .catch(() => {})
}, 30_000)

$('#navEntry').addEventListener('change', async (e) => {
  try { const r = await post('/prefs', { showNavEntry: e.target.checked }); state.prefs = r.prefs || state.prefs; toast(e.target.checked ? '已开启导航入口（重启生效）' : '已隐藏导航入口（重启生效）') }
  catch (err) { toast(`保存失败: ${err.message}`) }
})
$('#notifyDesktop').addEventListener('change', async (e) => {
  try { const r = await post('/prefs', { notifyDesktop: e.target.checked }); state.prefs = r.prefs || state.prefs; toast(e.target.checked ? '已开启桌面通知' : '已关闭桌面通知') }
  catch (err) { toast(`保存失败: ${err.message}`) }
})
// 阅读字号：设置页统一调覆盖并清除各页分项；重置=清空 fontSize 全回默认
$('#btnFzDown').addEventListener('click', () => fzGlobal(-1))
$('#btnFzUp').addEventListener('click', () => fzGlobal(1))
$('#btnFzReset').addEventListener('click', () => {
  saveFontSize({}).then((ok) => ok && toast('字号已重置为默认（100%）'))
})
async function loadLoopGuard() {
  try {
    const g = await api('/loopguard')
    const cb = $('#loopGuard')
    cb.checked = g.pref !== null && g.pref !== undefined ? !!g.pref : !!g.installed
    $('#loopGuardInfo').textContent = !g.installed
      ? '未检测到 dsh-loop-recover——可到市场安装后开启本项'
      : !g.enabled ? 'dsh-loop-recover 已安装但未启用——请在 dsh 插件管理中启用后本项才会生效' : ''
  } catch { /* 老后端无此接口则静默 */ }
}
$('#loopGuard').addEventListener('change', async (e) => {
  try {
    const r = await post('/prefs', { loopGuard: e.target.checked })
    state.prefs = r.prefs || state.prefs
    if (e.target.checked) {
      const g = await api('/loopguard').catch(() => null)
      if (g && !g.installed) toast('未检测到 dsh-loop-recover——本项暂不生效，可到市场安装')
      else if (g && !g.enabled) toast('dsh-loop-recover 已安装但未启用——请在插件管理中启用')
      else toast('已开启模型输出死循环过滤')
    } else toast('已关闭模型输出死循环过滤')
    loadLoopGuard()
  } catch (err) { toast(`保存失败: ${err.message}`) }
})
// 数据备份：四项偏好合一保存；立即备份走 /backup
function saveBackup() {
  return post('/prefs', { backup: {
    enabled: $('#backupEnabled').checked,
    period: $('#backupPeriod').value,
    dir: $('#backupDir').value.trim(),
    keep: +$('#backupKeep').value || 7,
  } }).then((r) => { state.prefs = r.prefs || state.prefs })
}
for (const id of ['backupEnabled', 'backupPeriod', 'backupDir', 'backupKeep']) {
  $(`#${id}`).addEventListener('change', () => {
    saveBackup().then(() => toast('备份设置已保存')).catch((e) => toast(`保存失败: ${e.message}`))
  })
}
function loadBackup() {
  const b = state.prefs?.backup || {}
  $('#backupEnabled').checked = !!b.enabled
  $('#backupPeriod').value = b.period || 'day'
  $('#backupDir').value = b.dir || ''
  $('#backupKeep').value = b.keep ?? 7
}
$('#btnBackupNow').addEventListener('click', async () => {
  $('#backupInfo').textContent = '备份中…'
  try {
    await saveBackup() // 先落当前配置再跑
    const r = await post('/backup', {})
    $('#backupInfo').textContent = `已备份: ${r.file}`
    toast('备份完成')
  } catch (e) { $('#backupInfo').textContent = ''; toast(`备份失败: ${e.message}`) }
})
// 恢复：先停在跑任务 → 解 zip → 热替换库/设置/日报，免重启——成功后刷新页面取新状态
$('#btnRestore').addEventListener('click', async () => {
  const path = $('#restorePath').value.trim()
  if (!path) { toast('先填备份 zip 路径'); return }
  if (!confirm('恢复会先停止正在抓取/生成的任务，然后覆盖当前新闻库、日报/快报和全部设置，确定继续？')) return
  $('#backupInfo').textContent = '停止任务并恢复中…'
  try {
    const r = await post('/restore', { path })
    $('#backupInfo').textContent = ''
    if (r.needsRestart) { toast('已就绪：重启 dsh 后生效'); return }
    toast('已恢复，正在刷新…')
    setTimeout(() => location.reload(), 800)
  } catch (e) { $('#backupInfo').textContent = ''; toast(`恢复失败: ${e.message}`) }
})
// 备份文件夹：系统目录选择走宿主 directoryPicker native 能力（/api/pick-dir）
$('#btnPickBackupDir').addEventListener('click', async () => {
  const btn = $('#btnPickBackupDir')
  btn.disabled = true
  try {
    const r = await post('/pick-dir', {})
    if (r.supported === false) { toast('当前环境不支持系统目录选择，请手动输入或拖入文件夹'); return }
    if (r.path) {
      $('#backupDir').value = r.path
      await saveBackup()
      toast('备份文件夹已保存')
    } // path=null 是用户取消，不提示
  } catch (e) { toast(`选择失败: ${e.message}`) }
  finally { btn.disabled = false }
})
$('#autoTranslate').addEventListener('change', async (e) => {
  $('#autoTlWarn').hidden = !e.target.checked
  try { const r = await post('/prefs', { autoTranslate: e.target.checked }); state.prefs = r.prefs || state.prefs; toast(e.target.checked ? '已开启自动翻译' : '已关闭自动翻译') }
  catch (err) { toast(`保存失败: ${err.message}`) }
})

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }

// ---- 每日精选日报 ----

const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
async function loadDigest() {
  if (state.digestKind === 'topics') return loadTopicsView() // AI专题走自己的列表/详情分支
  const ld = new Date()
  const localDay = dayStr(ld)
  const dv = $('#digestDay').value.trim()
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dv) ? dv : localDay // 本地日界：UTC toISOString 会让凌晨看到的日期停在昨天
  $('#digestDay').value = day
  $('#digestView').dataset.kind = state.digestKind // 字号变量按 kind 取（--fz-digest/--fz-hourly）
  try {
    const r = await api(state.digestKind === 'hourly' ? `/briefs?day=${day}&type=${encodeURIComponent(state.briefSel)}` : `/digest/${day}`)
    state.digestRendered = r.markdown
    $('#digestView').className = 'digest'
    $('#digestView').innerHTML = mdLite(r.markdown)
    await injectDigestNavs(day)
  } catch {
    // 该天无日报但有快报 → 自动切快报展示（同一天的内容优先于跨天回退）
    // 仅限默认进入：用户显式点了「日报」就尊重选择，走"昨天日报→空态"的回退，不跳快报
    if (state.digestKind === 'digest' && !state.kindPinned) {
      try {
        const r = await api(`/briefs?day=${day}&type=all`)
        state.digestKind = 'hourly'
        $('#digestView').dataset.kind = 'hourly'
        syncKindUI()
        state.digestRendered = r.markdown
        $('#digestView').innerHTML = mdLite(r.markdown)
        await injectDigestNavs(day)
        return
      } catch { /* 快报也没有→继续原回退 */ }
    }
    // 请求的是"今天"且无日报→回退前一天（刚过0点新一天还没生成）
    // 仅限默认进入/跨天复位：用户当天手动选了今天就尊重选择，显示空态而不是跳回昨天
    if (state.digestKind === 'digest' && day === localDay && state.daySetOn !== localDay) {
      const y = new Date(ld); y.setDate(y.getDate() - 1)
      const yday = dayStr(y)
      try {
        const r = await api(`/digest/${yday}`)
        $('#digestDay').value = yday
        state.digestRendered = r.markdown
        $('#digestView').innerHTML = mdLite(r.markdown)
        await injectDigestNavs(yday)
        return
      } catch { /* 前一天也没有→走空态 */ }
    }
    state.digestRendered = ''
    $('#digestView').className = 'digest'
    const kindLabel = state.digestKind === 'hourly' ? '快报' : '日报'
    // 快报空态也要带标题下拉——单类型该日无文件时用户得能切回「今日快报」/别的类型
    $('#digestView').innerHTML = (state.digestKind === 'hourly' ? `<h1>今日快报 · ${esc(day)}</h1>` : '')
      + (state.generating
        ? `<p class="empty">⏳ ${kindLabel}生成中，请稍候…</p>`
        : `<p class="empty">${esc(day)} 无${kindLabel}（未到生成时间或抓取为空），可点「生成${kindLabel}」手动触发。</p>`)
    injectBriefTitle()
  }
}

/** 渲染后统一注入：日导航（先等它改写 h1）→ 快报标题下拉 → 时段/领域导航 → 字号控件 */
async function injectDigestNavs(day) {
  await injectDayNav(day) // 必须先完成：它重写 h1.innerHTML，后注入的节点才不会被清掉
  injectBriefTitle()
  injectHourNav()
  injectDomainNav()
  injectBriefToc()
  injectFzCtl()
}

/** 快报正文 h1「今日快报 · 2026-03-01」：标题部分换成自绘类型下拉（按钮=h1 字号，浮层选项小字号），切换即换文件 */
function injectBriefTitle() {
  if (state.digestKind !== 'hourly') return
  const h1 = $('#digestView h1')
  if (!h1 || h1.querySelector('.bt-title-dd')) return
  // h1 内是 [◀btn] 文本"今日快报 · 2026-03-01" [▶btn]——找到含 · 的文本节点切两半
  const txt = [...h1.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('·'))
  if (!txt) return
  const m = txt.textContent.match(/^(.*?)\s*·\s*(.*)$/)
  if (!m) return
  const dd = document.createElement('span')
  dd.className = 'bt-title-dd'
  dd.innerHTML = '<button type="button" class="bt-title-cur" title="切换快报类型（今日快报=全部类型合并视图）"></button><span class="bt-title-pop" hidden></span>'
  const cur = dd.querySelector('.bt-title-cur')
  const pop = dd.querySelector('.bt-title-pop')
  cur.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden })
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-btsel]')
    if (!b) return
    pop.hidden = true
    state.briefSel = b.dataset.btsel
    syncRunBtn(); loadDigest()
  })
  document.addEventListener('click', (e) => { if (!dd.contains(e.target)) pop.hidden = true }) // 点外部收起
  txt.textContent = ` · ${m[2].trim()}` // 保日期；标题文字由下拉接管
  h1.insertBefore(dd, txt)
  refreshBriefTitleSel()
}

/** 日报标题两侧的前后日导航：相邻日有对应文件才显示箭头 */
async function injectDayNav(day) {
  const h1 = $('#digestView h1')
  if (!h1 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return
  const probe = async (delta) => {
    for (let i = 1; i <= 14; i++) { // 跳过没产出日报的日子（宕机/无数据），最多找 14 天
      const d = new Date(`${day}T00:00:00`); d.setDate(d.getDate() + delta * i)
      const ds = dayStr(d)
      try { await api(state.digestKind === 'hourly' ? `/briefs?day=${ds}&type=${encodeURIComponent(state.briefSel)}` : `/digest/${ds}`); return ds } catch { /* 这天没有→继续找 */ }
    }
    return null
  }
  const [prev, next] = await Promise.all([probe(-1), probe(1)])
  if (!prev && !next) return
  const mk = (ds, glyph, cls) => {
    if (!ds) return `<span class="daynav off">${glyph}</span>`
    return `<button class="daynav ${cls}" data-day="${ds}" title="查看 ${ds}">${glyph}</button>`
  }
  h1.innerHTML = `${mk(prev, '◀', 'prev')} ${h1.innerHTML} ${mk(next, '▶', 'next')}`
  h1.querySelectorAll('.daynav[data-day]').forEach((b) => b.addEventListener('click', () => {
    $('#digestDay').value = b.dataset.day
    state.daySetOn = dayStr(new Date())
    state.dayPicked = b.dataset.day
    loadDigest()
  }))
}

/** 快报各时段标题旁的上下跳转：▲上一时段(更新) ▼下一时段(更早)；日报无时段标题则空操作 */
// 150ms 快平滑：原生 smooth 不可调速（~400ms），瞬时又太跳——easeOutQuad 快速到位。
// 时段 ▲▼ 导航与领域目录 #锚点链接共用。
function fastScrollTo(t) {
  const from = window.scrollY
  const dist = t.getBoundingClientRect().top - 64 // 64 = scroll-margin-top 对齐 sticky 栏
  const t0 = performance.now()
  const step = (now) => {
    const p = Math.min(1, (now - t0) / 150)
    window.scrollTo(0, from + dist * (1 - (1 - p) * (1 - p)))
    if (p < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/** 日报领域导航：### 领域 标题右侧加 ▲上一域 ▼下一域 ⤴返回目录（DOM 注入，不动 markdown 锚点） */
function injectDomainNav() {
  const kids = [...$('#digestView').children]
  const startIdx = kids.findIndex((el) => el.tagName === 'H2' && /重要新闻|Top Stories/.test(el.textContent))
  if (startIdx < 0) return
  const tocH2 = kids.find((el) => el.tagName === 'H2' && /领域目录/.test(el.textContent))
  const doms = []
  for (let i = startIdx + 1; i < kids.length; i++) {
    if (kids[i].tagName === 'H2') break
    if (kids[i].tagName === 'H3') doms.push(kids[i])
  }
  const names = doms.map((h) => h.textContent.trim())
  doms.forEach((h, i) => {
    const up = i > 0 ? `<button class="daynav hour" data-dto="${i - 1}" title="上一领域 ${names[i - 1]}">▲</button>` : '<span class="daynav off">▲</span>'
    const down = i < doms.length - 1 ? `<button class="daynav hour" data-dto="${i + 1}" title="下一领域 ${names[i + 1]}">▼</button>` : '<span class="daynav off">▼</span>'
    const back = tocH2 ? '<button class="daynav hour" data-dtoc="1" title="返回领域目录">⤴</button>' : ''
    h.insertAdjacentHTML('beforeend', ` ${up} ${down} ${back}`)
  })
  doms.forEach((h) => h.querySelectorAll('.daynav.hour').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.dtoc) { if (tocH2) fastScrollTo(tocH2); return }
    const t = doms[+b.dataset.dto]
    if (t) fastScrollTo(t)
  })))
}

/** 节标题右侧字号控件：日报→各 h2（概述/领域目录/重要新闻…）；快报→各 h3（领域速览/重要新闻） */
function injectFzCtl() {
  const hourly = state.digestKind === 'hourly'
  $('#digestView').querySelectorAll(hourly ? 'h3' : 'h2').forEach((h) => {
    if (!h.querySelector('.fz-ctl')) h.insertAdjacentHTML('beforeend', fzCtl(hourly ? 'hourly' : 'digest'))
  })
}

function injectHourNav() {
  const secs = [...document.querySelectorAll('#digestView h2')].filter((h) => /^\d{2}:\d{2}\s/.test(h.textContent.trim())) // 今日快报列表：各类型节都是 `## HH:mm 名`——任意节名都计入时段导航
  secs.forEach((h, i) => {
    const up = i > 0 ? `<button class="daynav hour" data-to="${i - 1}" title="上一时段 ${secs[i - 1].textContent.trim().slice(0, 5)}">▲</button>` : '<span class="daynav off">▲</span>'
    const down = i < secs.length - 1 ? `<button class="daynav hour" data-to="${i + 1}" title="下一时段 ${secs[i + 1].textContent.trim().slice(0, 5)}">▼</button>` : '<span class="daynav off">▼</span>'
    h.insertAdjacentHTML('beforeend', ` ${up} ${down}`)
  })
  document.querySelectorAll('#digestView .daynav.hour').forEach((b) => b.addEventListener('click', () => {
    const t = secs[+b.dataset.to]
    if (t) fastScrollTo(t)
  }))
}

/** 快报节标题可点：包一层 .bt-toc-btn，点击弹出当前视图全部节目录，点条目滚动跳转。
 *  目录点击时从实时 DOM 构建——生成新快报自动 loadDigest 后老节也能看到新节；单类型视图只列该类型的节 */
const briefSecs = () => [...document.querySelectorAll('#digestView h2')].filter((h) => h.querySelector('.bt-toc-btn'))
function injectBriefToc() {
  if (state.digestKind !== 'hourly') return
  document.querySelectorAll('#digestView h2').forEach((h) => {
    const txt = [...h.childNodes].find((n) => n.nodeType === 3 && /^\d{2}:\d{2}\s/.test(n.textContent.trim()))
    if (!txt) return
    const b = document.createElement('button')
    b.className = 'bt-toc-btn'; b.title = '快报节跳转'
    b.textContent = txt.textContent.trim()
    h.replaceChild(b, txt)
    h.classList.add('bt-sec')
  })
}
const closeTocPop = () => document.querySelector('#digestView .bt-toc-pop')?.remove()
$('#digestView').addEventListener('click', (e) => {
  const hit = e.target.closest('.bt-toc-pop')
  if (hit) { // 目录内点击：条目跳转后关层
    const b = e.target.closest('[data-toci]')
    if (b) { const t = briefSecs()[+b.dataset.toci]; closeTocPop(); if (t) fastScrollTo(t) }
    return
  }
  const btn = e.target.closest('.bt-toc-btn')
  if (!btn) return
  const h = btn.closest('h2')
  const old = document.querySelector('#digestView .bt-toc-pop')
  if (old?.parentElement === h) { closeTocPop(); return } // 再点同一标题=收起
  closeTocPop()
  const secs = briefSecs()
  const pop = document.createElement('span')
  pop.className = 'bt-title-pop bt-toc-pop'
  pop.innerHTML = secs.map((s, i) => `<button data-toci="${i}" class="${s === h ? 'on' : ''}">${esc(s.querySelector('.bt-toc-btn').textContent)}</button>`).join('')
  h.appendChild(pop)
})
document.addEventListener('click', (e) => { if (!e.target.closest('.bt-toc-btn') && !e.target.closest('.bt-toc-pop')) closeTocPop() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTocPop() })

// 节标题右侧字号控件：委托到 #digestView（缩放作用于当前 kind 对应视图）
$('#digestView').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-fz]')
  if (b) fzStep(b.dataset.fz, +b.dataset.d)
})
// 引用弹层边缘钳制：* 在行首/行尾时弹层居中会飞出视口，mouseover 时按实际 rect 平移收回
$('#digestView').addEventListener('mouseover', (e) => {
  const c = e.target.closest('.cite')
  const pop = c?.querySelector('.cite-pop')
  if (!pop) return
  pop.style.transform = 'translateX(-50%)'
  const r = pop.getBoundingClientRect() // visibility:hidden 也有布局，可量
  let dx = 0
  if (r.right > innerWidth - 8) dx = innerWidth - 8 - r.right
  if (r.left + dx < 8) dx = 8 - r.left
  if (dx) pop.style.transform = `translateX(calc(-50% + ${dx}px))`
})

// 领域目录/返回目录等 #锚点链接：委托到 #digestView 一次绑定，走同一个 150ms 快速滚动。
// 快报同名 #### 领域 跨时段重复：优先在链接所在的 ## 节内命中，避免旧时段跳到最新节的同名块
$('#digestView').addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]')
  if (!a) return
  const id = a.getAttribute('href').slice(1)
  const hs = [...$('#digestView').querySelectorAll('h2,h3,h4')]
  const start = hs.filter((h) => h.tagName === 'H2' && h.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING).pop()
  const cands = hs.filter((h) => h.id === id)
  const t = (start && cands.find((h) => h.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_PRECEDING)) || cands[0]
  if (!t) return
  e.preventDefault()
  fastScrollTo(t)
})

/** 轻量 Markdown 渲染：h1-h4/列表/引用/粗体/斜体/行内码/链接/横线——覆盖日报全部语法 */
function mdLite(md) {
  const inline = (t) => esc(t)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+?)(?:\s+&quot;(.*?)&quot;)?\)/g, (m, t, u, ti) => `<a href="${u}"${ti ? ` title="${ti}"` : ''} target="_blank" rel="noopener">${t}</a>`)
    .replace(/\[([^\]]+)\]\((#[^)\s]+?)(?:\s+&quot;(.*?)&quot;)?\)/g, (m, t, u, ti) => `<a href="${u}"${ti ? ` title="${ti}"` : ''}>${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
  const out = []
  let inUl = false, inOl = false, inBq = false
  const closeLists = () => { if (inUl) { out.push('</ul>'); inUl = false } if (inOl) { out.push('</ol>'); inOl = false } if (inBq) { out.push('</blockquote>'); inBq = false } }
  for (const raw of md.split('\n')) {
    const l = raw.trimEnd(), e = inline(l)
    const h = l.match(/^(#{1,4})\s+(.*)$/)
    if (h) { closeLists(); const id = h[2].replace(/[<>"'`]/g, '').trim(); out.push(`<h${h[1].length} id="${id}">${inline(h[2])}</h${h[1].length}>`); continue }
    if (l.startsWith('>')) { const c = l.replace(/^>\s?/, ''); if (!c.trim()) continue; if (!inBq) { closeLists(); out.push('<blockquote>'); inBq = true } else out.push('<br>'); out.push(inline(c)); continue }
    if (/^---+$/.test(l.trim())) { closeLists(); out.push('<hr>'); continue }
    if (l.startsWith('- ') || l.startsWith('* ')) { if (inOl) { out.push('</ol>'); inOl = false } if (!inUl) { out.push('<ul>'); inUl = true } out.push(`<li>${inline(l.slice(2))}</li>`); continue }
    const ol = l.match(/^(\d+)\.\s+(.*)$/)
    if (ol) { if (inUl) { out.push('</ul>'); inUl = false } if (!inOl) { out.push('<ol>'); inOl = true } out.push(`<li>${inline(ol[2])}</li>`); continue }
    closeLists()
    if (l.trim()) out.push(`<p>${e}</p>`)
  }
  closeLists()
  return out.join('')
}

$('#digestDay').addEventListener('change', () => { state.daySetOn = dayStr(new Date()); state.dayPicked = $('#digestDay').value.trim(); loadDigest() })
const syncRunBtn = () => {
  const b = $('#btnDigestRun')
  if (state.digestKind === 'hourly') {
    const t = state.briefTypes.find((x) => x.id === state.briefSel)
    b.textContent = `▶ 生成快报${t ? `·${t.name}` : ''}`
    b.title = '抓取所选快报类型的新闻源，评分后生成快报（标题选「今日快报」则各类型一起跑）'
  }
  else { b.textContent = '▶ 生成日报'; b.title = '立即生成今日日报' }
}
/** 快报类型表：正文 h1「今日快报」标题即下拉（'all'=各类型文件按节合并视图；单类型=该类型当日文件） */
async function loadBriefTypes() {
  try {
    const r = await api('/brief-types')
    state.briefTypes = r.types || []
    if (state.briefSel !== 'all' && !state.briefTypes.some((t) => t.id === state.briefSel)) state.briefSel = 'all'
    refreshBriefTitleSel() // 标题下拉选项跟着最新表走（含停用标注）
    syncRunBtn() // 选中类型名进按钮文案
  } catch { /* 类型列表不可达则保持现状 */ }
}
/** 正文 h1 里的类型下拉（自绘：按钮大字 + 浮层小字选项，macOS 原生弹层控不了 option 字号） */
function refreshBriefTitleSel() {
  const dd = $('#digestView .bt-title-dd')
  if (!dd) return
  const cur = state.briefSel
  const items = [{ id: 'all', name: '今日快报', enabled: true }, ...(state.briefTypes || [])]
  const curName = items.find((t) => t.id === cur)?.name || '今日快报'
  dd.querySelector('.bt-title-cur').textContent = curName
  dd.querySelector('.bt-title-pop').innerHTML = items.map((t) =>
    `<button data-btsel="${esc(t.id)}" class="${t.id === cur ? 'on' : ''}">${esc(t.name)}${t.enabled === false ? '（停用）' : ''}</button>`).join('')
}
/** seg 三态 UI 同步：专题显示新建钮与 topics 字号控件；快报显示类型下拉与「快报列表」管理钮；日期框三态共用 */
const syncKindUI = () => {
  const k = state.digestKind
  const tp = k === 'topics'
  const hb = k === 'hourly'
  $('#btnKindDigest').classList.toggle('active', k === 'digest')
  $('#btnKindHourly').classList.toggle('active', k === 'hourly')
  $('#btnKindTopics').classList.toggle('active', k === 'topics')
  $('#digestDay').title = tp ? '筛选专题：该日生成的 + 新闻时间范围覆盖该日的；留空显示全部' : '查看历史日报（生成始终针对今天）'
  $('#btnTopicNew').hidden = !tp
  $('#btnBriefList').hidden = !hb
  if (hb) loadBriefTypes() // 每次切入快报都拉最新类型表（别处改过也立即可见）
  if (tp) $('#btnDigestRun').hidden = true
  else { $('#btnDigestRun').hidden = state.generating; syncRunBtn() }
}
for (const [id, kind] of [['btnKindDigest', 'digest'], ['btnKindHourly', 'hourly'], ['btnKindTopics', 'topics']]) {
  $(`#${id}`).addEventListener('click', () => {
    state.digestKind = kind
    state.kindPinned = true // 显式选 kind：日报缺文件回退昨天日报，不再自动跳快报
    if (kind === 'topics') { state.topicView = 'list'; $('#digestDay').value = '' } // 切进专题默认回列表页+清日期筛（看全部）
    syncKindUI(); loadDigest()
  })
}

// ---- AI 专题：列表 / 详情 / 新建弹层 / 生成进度 ----

let topicSeq = 0 // 列表/详情请求序号：仅最新一轮允许写 DOM
async function loadTopicsView() {
  const dv = $('#digestView')
  dv.className = 'topicwrap' // 脱离日报卡样式；字号吃 --fz-topics
  dv.dataset.kind = 'topics'
  if (state.topicView === 'detail' && state.topicId) return loadTopicDetail(state.topicId)
  const seq = ++topicSeq
  dv.innerHTML = '<p class="empty">加载专题列表…</p>'
  try {
    const r = await api('/topics')
    if (seq !== topicSeq || state.digestKind !== 'topics') return
    renderTopicList(r.topics || [])
  } catch (e) {
    if (seq === topicSeq) dv.innerHTML = `<p class="err">加载失败: ${esc(e.message)}</p>`
  }
}

// meta 行结构：A−A＋(挪到生成日期左面) · 生成时间 · [起~止 胶囊] · 入文/引用 · 降级标
const tpMetaLine = (m) => `${fzCtl('topics')} ${esc((m.createdAt || '').slice(0, 16).replace('T', ' '))} · <span class="tp-range">${esc(m.from || '最早')} ~ ${esc(m.to || '最新')}</span> · 入文 ${m.itemCount || 0} 条${m.usedCount ? ` · 引用 ${m.usedCount}` : ''}${m.degraded ? ' · ⚠降级' : ''}`

/** 专题按日筛选：该日生成的（createdAt）或新闻时间范围覆盖该日的（from~to），日期框留空/非法值→全部 */
const topicOnDay = (m, day) =>
  (m.createdAt || '').slice(0, 10) === day ||
  ((m.from || '0000-00-00') <= day && day <= (m.to || '9999-99-99'))

function renderTopicList(topics) {
  const dv = $('#digestView')
  const dv0 = $('#digestDay').value.trim()
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dv0) ? dv0 : ''
  const shown = day ? topics.filter((m) => topicOnDay(m, day)) : topics
  if (!shown.length) {
    dv.innerHTML = day
      ? `<p class="empty">${esc(day)} 没有生成或覆盖该日的专题——<a class="tp-clear" data-tact="clear-day">清空日期框</a>看全部。</p>`
      : '<p class="empty">还没有专题——点右上「＋ 新建专题」，按关键词从你的新闻库生成一份专题报告。</p>'
    return
  }
  dv.innerHTML = shown.map((m) => {
    const id = esc(m.id)
    const kws = (m.keywords || []).map((k) => `<span class="tag">${esc(k)}</span>`).join('')
    const ops = m.status === 'generating'
      ? `<span class="trow-status">⏳ 生成中…</span><button data-tact="stop" data-id="${id}" title="停止该专题生成（含残留状态修复）">⏹ 停止</button>`
      : m.status === 'queued'
        ? `<span class="trow-status">⌛ 排队中</span><button data-tact="stop" data-id="${id}" title="取消排队——不再生成该专题">⏹ 取消排队</button>`
        : `<button data-tact="edit" data-id="${id}" title="修改本专题的关键词/时间/源等设置并重新生成">✎ 修改专题</button><button data-tact="regen" data-id="${id}"${m.status === 'error' ? ' data-force="1"' : ''} title="${m.status === 'error' ? '直接重新生成（失败态无需确认）' : '同参数覆盖重生成'}">⟳ 再次生成</button>`
        + (m.status === 'error' ? '' : `<button data-tact="export" data-id="${id}" title="导出 Markdown 到指定目录">⇩ 导出</button>`)
        + `<button data-tact="del" data-id="${id}" title="删除该专题（二次确认）">✕ 删除</button>`
    return `<div class="trow" data-id="${id}">
      <div class="trow-head"><a class="trow-title" data-tact="open" data-id="${id}">${esc(m.title || '专题')}</a><span class="trow-ops">${ops}</span></div>
      ${m.status === 'error' ? `<div class="trow-err">✗ 生成失败：${esc(m.error || '未知原因')}</div>` : (m.excerpt ? `<div class="trow-ex">${esc(m.excerpt)}</div>` : '')}
      <div class="trow-meta">${kws}<span class="trow-when">${tpMetaLine(m)}</span></div>
    </div>`
  }).join('')
}

/** 专题引用升级（渲染层，不动存储 md）：内联 [N](url) 收成 * 上标——悬停即弹引用列表，点击星标跳到参考区对应条目；参考区 li 补真编号徽标+锚点（mdLite 的 ol 会丢原 N）。
 * 书里 * 脚注语义：星号处只留一个标，被引用的几条新闻在弹层/底部列表里点开。 */
function upgradeTopicRefs(article, md) {
  if (!article) return
  const refMap = new Map() // n → {title,url,tail}
  const refSec = md.split(/\n## 参考新闻/)
  if (refSec[1]) for (const m of refSec[1].matchAll(/^(\d+)\.\s+\[([^\]]*)\]\(([^)\s]+)\)\s*(.*)$/gm))
    refMap.set(+m[1], { n: +m[1], title: m[2], url: m[3], tail: m[4].replace(/^[ ·]+/, '') })
  if (!refMap.size) return
  const hs = [...article.querySelectorAll('h2')].find((h) => h.textContent.trim().startsWith('参考新闻'))
  if (hs) hs.id = 'topicRefs'
  // 参考区 li 按 URL 对上编号（li 顺序与 usedNums 升序一致，URL 匹配更稳），补 id 锚点+真编号徽标
  const byUrl = new Map([...refMap.values()].map((r) => [r.url, r]))
  if (hs) for (const ol of hs.parentElement.querySelectorAll('ol')) {
    if (!(ol.compareDocumentPosition(hs) & Node.DOCUMENT_POSITION_PRECEDING)) continue
    ol.classList.add('trefs')
    for (const li of ol.querySelectorAll('li')) {
      const a = li.querySelector('a[href]')
      const r = a && byUrl.get(a.getAttribute('href'))
      if (!r || li.id) continue
      li.id = `tref-${r.n}`; li.classList.add('tref')
      li.insertAdjacentHTML('afterbegin', `<b class="tref-n">${r.n}</b>`)
    }
  }
  const isCite = (a) => a.tagName === 'A' && /^\d{1,3}$/.test(a.textContent.trim()) && refMap.has(+a.textContent.trim())
    && (!hs || (a.compareDocumentPosition(hs) & Node.DOCUMENT_POSITION_FOLLOWING)) // 只收参考区之前的链接
  for (const a of [...article.querySelectorAll('a')]) {
    if (!a.isConnected || !isCite(a)) continue
    const cluster = [a]
    let sib = a.nextSibling // 连续引用 [2][56][62]（逗号/顿号间隔）并成一个星标
    while (sib) {
      if (sib.nodeType === 3 && /^[，,、·\s]*$/.test(sib.textContent)) { sib = sib.nextSibling; continue }
      if (sib.nodeType === 1 && isCite(sib)) { cluster.push(sib); sib = sib.nextSibling; continue }
      break
    }
    const nums = cluster.map((x) => +x.textContent.trim())
    const pop = nums.map((n) => {
      const r = refMap.get(n)
      return `<a class="cite-it" href="${r.url}" target="_blank" rel="noopener"><b>${n}</b><span><i>${esc(r.title)}</i><small>${esc(r.tail)}</small></span></a>`
    }).join('')
    const sup = document.createElement('sup')
    sup.className = 'cite'
    sup.innerHTML = `<a class="cite-star" href="#tref-${nums[0]}" title="查看参考新闻">*</a><span class="cite-pop">${pop}</span>`
    cluster[0].replaceWith(sup)
    for (let i = 1; i < cluster.length; i++) cluster[i].remove()
  }
}

async function loadTopicDetail(id) {
  const dv = $('#digestView')
  dv.className = 'topicwrap'
  const tbar = (m) => `<div class="tbar"><button data-tact="back">‹ 返回列表</button><span class="tbar-r">${m?.status === 'done'
    ? `<button data-tact="edit" data-id="${esc(id)}" title="修改本专题设置并重新生成">✎ 修改专题</button><button data-tact="regen" data-id="${esc(id)}">⟳ 再次生成</button><button data-tact="export" data-id="${esc(id)}">⇩ 导出</button><button data-tact="del" data-id="${esc(id)}">✕ 删除</button>`
    : m?.status === 'error'
      ? `<button data-tact="edit" data-id="${esc(id)}" title="修改本专题设置并重新生成">✎ 修改专题</button><button data-tact="regen" data-id="${esc(id)}" data-force="1" title="直接重新生成（失败态无需确认）">⟳ 再次生成</button><button data-tact="del" data-id="${esc(id)}">✕ 删除</button>`
      : (m?.status === 'generating' || m?.status === 'queued') ? `<button data-tact="stop" data-id="${esc(id)}">⏹ ${m.status === 'queued' ? '取消排队' : '停止'}</button>` : ''}</span></div>`
  try {
    const r = await api(`/topics/${encodeURIComponent(id)}`)
    const m = r.meta
    if (r.markdown) {
      const staleNote = m?.status === 'generating' ? '<p class="topic-stalenote">⟳ 正在重新生成——以下为旧版内容，完成后自动刷新</p>'
        : m?.status === 'queued' ? '<p class="topic-stalenote">⌛ 排队重生成中——以下为旧版内容</p>'
          : m?.status === 'error' ? `<p class="topic-stalenote err">✗ 上次生成失败：${esc(m.error || '未知原因')}——以下为旧版内容，可再次生成</p>` : ''
      dv.innerHTML = `${tbar(m)}${staleNote}<article class="digest" data-kind="topics">${mdLite(r.markdown)}</article>`
      upgradeTopicRefs(dv.querySelector('.digest'), r.markdown) // 引用标→* 脚注（悬停弹层/点击跳参考区）
      dv.querySelector('.digest h1')?.insertAdjacentHTML('beforeend', fzCtl('topics')) // 字号控件紧邻标题右侧
    } else {
      const st = m?.status === 'generating'
        ? '<p class="empty">⏳ 专题生成中，稍候自动刷新…</p>'
        : m?.status === 'queued'
          ? '<p class="empty">⌛ 排队中——前方专题生成完自动开始，可点右上「取消排队」撤销。</p>'
          : `<p class="err">✗ 生成失败：${esc(m?.error || '未知原因')}——可再次生成或删除。</p>`
      dv.innerHTML = `${tbar(m)}<div class="topic-statecard">${st}</div>`
    }
  } catch (e) {
    dv.innerHTML = `${tbar(null)}<p class="err">加载失败: ${esc(e.message)}</p>`
  }
}

// 列表/详情内全部操作走一个委托（再生成/删除二次确认复用 armOnce）
$('#digestView').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tact]')
  if (!b) return
  e.preventDefault()
  const id = b.dataset.id
  const act = b.dataset.tact
  if (act === 'open') { state.topicView = 'detail'; state.topicId = id; loadTopicsView(); return }
  if (act === 'back') { state.topicView = 'list'; state.topicId = ''; loadTopicsView(); return }
  if (act === 'clear-day') { $('#digestDay').value = ''; loadTopicsView(); return } // 空态一键清日期筛，回全部专题
  if (act === 'stop') {
    try {
      const r = await post('/topic-stop', { id })
      toast(r?.result?.cancelled === 'waiting' || r?.result?.cancelled === 'queued' ? '已取消排队中的专题' : '已请求停止，在飞的调用收尾后结束')
      setTimeout(loadTopicsView, 1200)
    } catch (err) { toast(`停止失败: ${err.message}`) }
    return
  }
  if (act === 'edit') { openTopicEdit(id); return }
  if (act === 'regen') {
    // error 态免确认直接重跑（失败本就没什么可覆盖）；done 态仍武装确认——会覆盖一份好报告
    if (b.dataset.force !== '1' && !armOnce(b, '⟳ 再次生成', '⚠ 确认覆盖重生成？再点一次执行')) return
    const pc = await askPeak('专题重生成')
    if (pc === 'cancel') return
    try {
      const r = await post(`/topics/${encodeURIComponent(id)}/regen`, { peakBypass: pc === 'now' })
      state.topicView = 'list'; state.topicId = ''
      toast(r?.peakHeld ? '已排入低峰队列，出峰自动开始' : '专题已开始重新生成')
      startTopicWatch(); loadTopicsView()
    } catch (err) { toast(`重生成失败: ${err.message}`) }
    return
  }
  if (act === 'del') {
    if (!armOnce(b, '✕ 删除', '⚠ 确认删除专题？再点一次执行')) return
    try {
      await post(`/topics/${encodeURIComponent(id)}/delete`, {})
      toast('专题已删除')
      state.topicView = 'list'; state.topicId = ''; loadTopicsView()
    } catch (err) { toast(`删除失败: ${err.message}`) }
    return
  }
  if (act === 'export') {
    b.disabled = true
    try {
      const pr = await post('/pick-dir', {}).catch(() => null)
      if (pr && pr.supported !== false && !pr.path) return // 选择器弹出但用户取消
      if (pr?.supported === false) toast('当前环境不支持目录选择，导出到默认 exports/ 目录')
      const r = await post(`/topics/${encodeURIComponent(id)}/export`, { dir: pr?.path || undefined }) // 无 dir→后端默认 exports/
      toast(`已导出到 ${r.file}`)
    } catch (err) { toast(`导出失败: ${err.message}`) }
    finally { b.disabled = false }
  }
})

// 专题生成进度轮询：与日报/抓取共用 busybar + 停止键（日报生成中不占条）
// ---- busybar 归属仲裁：fetch/digest/topic 三管线写同一进度条——digest/topic 优先于 fetch，同级先到先得 ----
let busyOwner = ''
const BUSY_RANK = { fetch: 1, digest: 2, topic: 2 }
const busyShow = (owner, text) => {
  if (busyOwner && busyOwner !== owner && (BUSY_RANK[busyOwner] || 0) > (BUSY_RANK[owner] || 0)) return
  busyOwner = owner
  $('#digestBusy').hidden = false
  $('#digestBusy').textContent = text
}
const busyDone = (owner) => {
  if (busyOwner !== owner) return
  busyOwner = ''
  $('#digestBusy').hidden = true
  if (!state.generating) $('#btnDigestStop').hidden = true
}
// ---- 任务队列悬停面板：悬停 busybar 拉 /tasks 全量列表（running+waiting），逐项可取消 ----
const taskSfx = (n) => n ? ` · +${n} 任务排队` : '' // busybar 尾缀：本任务之外还有任务在等位
const STAGE_ZH = { fetch: '抓取中', score: '评分中', judge: '过滤中', translate: '翻译中', cluster: '聚类去重中', summaries: '条目摘要中', finishing: '收尾中', candidates: '筛选候选中', chunks: '分块小结中', backfill: '低峰补跑中', brief: '快报生成中' }
const stageZh = (s) => STAGE_ZH[s] ?? s // 任务弹层/忙条共用：未知 stage 原样透传
let tqTimer = 0
async function refreshTaskPop() {
  const pop = $('#taskPop')
  if (!pop) return
  const r = await api('/tasks').catch(() => null)
  if (!r?.ok) return
  const rows = [
    ...(r.running || []).map((t) => `<div class="tq-row"><span class="tq-dot run">▶</span><span class="tq-lab">${esc(t.label)}${t.total ? ` · ${t.done}/${t.total}` : ''}${t.stage ? ` · ${esc(stageZh(t.stage))}` : ''}${fmtEta(t.etaMs)}</span><button class="tq-x" data-tcancel="${esc(t.id)}" title="停止该任务">✕</button></div>`),
    ...(r.waiting || []).map((t) => `<div class="tq-row"><span class="tq-dot wait">⌛</span><span class="tq-lab">${esc(t.label)} · ${t.held ? '高峰暂停中·等低峰' : `排队第 ${t.position} 位`}</span><button class="tq-x" data-tcancel="${esc(t.id)}" title="取消排队">✕</button></div>`),
  ]
  pop.innerHTML = `<div class="tq-head">任务队列 · 并发上限 ${r.limit}${r.peak ? ' · ⏸高峰中' : ''}</div>` + (rows.join('') || '<div class="tq-row"><span style="color:var(--dim)">当前无任务</span></div>')
}
$('#busyWrap').addEventListener('mouseenter', () => { refreshTaskPop(); tqTimer = setInterval(refreshTaskPop, 2000) })
$('#busyWrap').addEventListener('mouseleave', () => { clearInterval(tqTimer); tqTimer = 0 })
$('#taskPop').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tcancel]')
  if (!b) return
  e.preventDefault(); e.stopPropagation()
  try {
    const r = await post('/task-cancel', { id: b.dataset.tcancel })
    toast(r?.result?.cancelled === 'waiting' ? '已取消排队任务' : r?.result?.cancelled === 'pending' ? '已撤下合并的快报意图' : r?.result?.ok ? '已请求停止任务' : '该任务已不在队列中')
  } catch (err) { toast(`取消失败: ${err.message}`) }
  refreshTaskPop()
})
// 槽位/抓取 watcher：任一 fetch 任务在跑或在排就保持忙条（高峰挂起显示等低峰），全空收尾——排低峰/恢复探测共用
let slotWatch = 0
const startSlotWatch = (doneToast = '快报已生成') => {
  if (slotWatch) return
  let seenRun = false
  slotWatch = setInterval(async () => {
    try {
      const p = await api('/fetch-progress')
      if (p.running) { seenRun = true; busyShow('fetch', fetchProgText(p)); return } // 无前缀：快报/普通抓取/补跑共享——文案走 stageZh
      if (p.queued) { busyShow('fetch', p.held ? `⌛ 高峰暂停中·出峰自动执行…${taskSfx(p.taskWaiting)}` : `⌛ 任务排队中…${taskSfx(p.taskWaiting)}`); return }
      clearInterval(slotWatch); slotWatch = 0; busyDone('fetch')
      if (seenRun) { toast(doneToast); loadDigest() }
    } catch { /* 进度不可达不阻塞 */ }
  }, 1500)
}
function startTopicWatch() {
  state.topicBusy = true
  $('#btnDigestStop').hidden = false
  busyShow('topic', '⏳ 专题生成中…')
  let lastSig = ''
  let seenRun = false // 区分「跑完收尾」与「排队中被取消」——toast 文案不同
  const dp = setInterval(async () => {
    try {
      const p = await api('/topic-progress')
      const sig = `${p.running}:${p.id}:${(p.queuedIds || []).join(',')}` // 在跑 id + 排队名单变化→刷新视图（queued↔generating 转换、regen 完成都立即可见）
      if (sig !== lastSig) {
        lastSig = sig
        if (state.digestKind === 'topics') loadTopicsView()
      }
      if (p.running) {
        seenRun = true
        const tpStageTxt = { candidates: '筛选候选中', chunks: '分批小结中', finishing: '合并成文/起名中' }[p.stage] || '专题生成中'
        busyShow('topic', `⏳ ${tpStageTxt}…${p.total && p.stage === 'chunks' ? ` (已完成 ${p.done}/${p.total} 批)` : ''}${fmtEta(p.etaMs)}${fmtQueue(p.queue)}${taskSfx(p.taskWaiting)}`)
        return
      }
      if ((p.queuedIds || []).length) { // 本专题/别的专题还在全局队列等位——保持进度条活着继续轮询
        busyShow('topic', (p.heldIds || []).length ? `⌛ 高峰暂停中·出峰自动执行…${taskSfx(p.taskWaiting)}` : `⌛ 专题排队中…${taskSfx(p.taskWaiting)}`)
        return
      }
      clearInterval(dp)
      state.topicBusy = false
      busyDone('topic')
      toast(seenRun ? '专题生成已结束' : '专题排队已取消')
      if (state.digestKind === 'topics') loadTopicsView()
    } catch { /* 进度不可达不阻塞 */ }
  }, 1200)
  return dp
}

// ---- 新建专题弹层（照添加源弹层：输入区 + 实时预览 + 确认钮） ----

const tpSel = new Set() // 源勾选状态：过滤重渲不清选择
let tpEditId = '' // ''=新建模式；<id>=修改专题模式（同弹层预填，提交走 /regen 保存设置并重跑）
const tpParams = () => ({
  keywords: $('#tpKeywords').value.split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean).slice(0, 10),
  from: $('#tpFrom').value || '',
  to: $('#tpTo').value || '',
  sourceIds: [...tpSel],
  focus: $('#tpFocus').value.trim(),
  minScore: +$('#tpMinScore').value || 0,
  maxItems: +$('#tpMaxItems').value || 100,
})
function renderTpSrcs() {
  const k = $('#tpSrcQ').value.trim().toLowerCase()
  const list = (state.sources || []).filter((s) => !k || s.title.toLowerCase().includes(k) || (s.category || '').toLowerCase().includes(k))
  $('#tpSrcList').innerHTML = list.length
    ? list.map((s) => `<label class="tp-src"><input type="checkbox" class="tp-src" value="${esc(s.id)}" ${tpSel.has(s.id) ? 'checked' : ''}> ${esc(s.title)}</label>`).join('')
    : '<span class="empty">无匹配源</span>'
  $('#tpSrcCount').textContent = `已选 ${tpSel.size}/${(state.sources || []).length}`
}
let tpSeq = 0 // 预览请求序号：仅最新一轮允许写预览区
let tpPage = 1 // 入文集翻页（参数一变重置回 1）
let tpSrcFilter = null // 预览源 tag 过滤（仅展示，不动 tpSel 选择）
const tpPreviewItem = (i) => `<div class="pv-item"><i>${esc(i.source || '')}</i> <i>${esc(i.date || '')}</i> ${i.link ? `<a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : esc(i.title)} <span class="score ${i.score >= 8 ? 's-hi' : i.score >= 5 ? 's-mid' : 's-lo'}">${i.score || '—'}</span>${i.dupCount ? ` <i>同题${i.dupCount + 1}家</i>` : ''}</div>`
async function tpLoadPage(page) {
  const p = tpParams()
  const gen = $('#btnTpGen')
  if (!p.keywords.length) { $('#tpPreview').hidden = true; $('#tpPager').hidden = true; gen.disabled = true; return }
  const seq = ++tpSeq
  try {
    const r = await post('/topics/preview', { ...p, page, filterSourceId: tpSrcFilter })
    if (seq !== tpSeq) return
    tpPage = r.page
    const srcTags = (r.sources || []).length > 1
      ? `<div class="tp-tags"><button type="button" class="tp-tag${tpSrcFilter ? '' : ' on'}" data-tpsrc="">全部 ${r.capCount}</button>`
        + (r.sources || []).map((s) => `<button type="button" class="tp-tag${tpSrcFilter === s.id ? ' on' : ''}" data-tpsrc="${esc(s.id)}">${esc(s.title)} ${s.count}</button>`).join('') + '</div>'
      : ''
    $('#tpPreview').innerHTML = srcTags
      + `<div class="pv-head tp-stats">命中 ${r.hitCount} 条 · 去重后 ${r.dedupCount} 条 · 入文 ${r.capCount} 条</div>`
      + (r.items || []).map(tpPreviewItem).join('')
    $('#tpPreview').hidden = false
    const pc = r.pageCount || 1
    const fc = r.filterCount ?? r.capCount
    $('#tpPager').innerHTML = pc > 1
      ? `<button data-tppg="${tpPage - 1}" ${tpPage <= 1 ? 'disabled' : ''}>‹ 上一页</button><span>${tpPage} / ${pc} 页（共 ${fc} 条）</span><button data-tppg="${tpPage + 1}" ${tpPage >= pc ? 'disabled' : ''}>下一页 ›</button>`
      : `<span>共 ${fc} 条</span>`
    $('#tpPager').hidden = r.capCount === 0
    gen.disabled = r.capCount === 0 // 命中 0 禁用生成（用户自会换条件）
  } catch (e) {
    if (seq === tpSeq) { $('#tpPreview').innerHTML = `<div class="pv-head" style="color:var(--err)">预览失败: ${esc(e.message)}</div>`; $('#tpPreview').hidden = false }
  }
}
const scheduleTpPreview = debounce(() => { tpPage = 1; tpSrcFilter = null; tpLoadPage(1) }, 400)
$('#tpPreview').addEventListener('click', (e) => {
  const t = e.target.closest('.tp-tag')
  if (!t) return
  const v = t.dataset.tpsrc || null
  tpSrcFilter = tpSrcFilter === v ? null : v // 再点同一 tag 取消过滤
  tpLoadPage(1)
})
$('#tpPager').addEventListener('click', (e) => { const b = e.target.closest('button[data-tppg]'); if (b && !b.disabled) tpLoadPage(+b.dataset.tppg) })

$('#btnTopicNew').addEventListener('click', () => {
  $('#tpErr').hidden = true; $('#tpPreview').hidden = true; $('#tpPager').hidden = true; $('#btnTpGen').disabled = true
  tpEditId = ''; tpPage = 1; tpSrcFilter = null
  $('#tpTitle').textContent = '新建专题'; $('#btnTpGen').textContent = '生成专题'
  $('#tpKeywords').value = ''; $('#tpFocus').value = ''; $('#tpSrcQ').value = ''
  const today = new Date(), d30 = new Date(); d30.setDate(d30.getDate() - 30)
  $('#tpFrom').value = dayStr(d30); $('#tpTo').value = dayStr(today) // 默认近30天
  $('#tpMinScore').value = '0'; $('#tpMaxItems').value = '100'
  tpSel.clear(); for (const s of state.sources || []) tpSel.add(s.id) // 默认全选
  tpSrcListShow(false) // 源列表收起：点头行/输入框再展开
  renderTpSrcs()
  $('#topicModal').hidden = false
  $('#tpKeywords').focus()
  scheduleTpPreview()
})
// 修改专题：拉 meta 全量预填同一弹层，标题/提交钮切编辑态；sourceIds 空数组=全部源
async function openTopicEdit(id) {
  try {
    const r = await api(`/topics/${encodeURIComponent(id)}`)
    const m = r.meta
    if (!m) return toast('专题不存在或已被删除')
    tpEditId = id; tpPage = 1; tpSrcFilter = null
    $('#tpErr').hidden = true; $('#tpPager').hidden = true; $('#btnTpGen').disabled = false
    $('#tpPreview').innerHTML = '<div class="pv-load">候选预览加载中…</div>'; $('#tpPreview').hidden = false // 定高占位：预览必跑，先撑起高度防二次跳大
    $('#tpTitle').textContent = '修改专题'; $('#btnTpGen').textContent = '再次生成'
    $('#tpKeywords').value = (m.keywords || []).join(' ')
    $('#tpFrom').value = m.from || ''; $('#tpTo').value = m.to || ''
    $('#tpFocus').value = m.focus || ''; $('#tpSrcQ').value = ''
    $('#tpMinScore').value = String(m.minScore ?? 0); $('#tpMaxItems').value = String(m.maxItems ?? 100)
    tpSel.clear()
    if (m.sourceIds?.length) for (const s of m.sourceIds) tpSel.add(s)
    else for (const s of state.sources || []) tpSel.add(s.id)
    tpSrcListShow(false); renderTpSrcs()
    $('#topicModal').hidden = false
    $('#tpKeywords').focus()
    scheduleTpPreview()
  } catch (e) { toast(`读取专题设置失败: ${e.message}`) }
}
$('#topicModal').addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target.closest('[data-close]')) $('#topicModal').hidden = true })
for (const id of ['tpKeywords', 'tpFocus', 'tpFrom', 'tpTo']) $(`#${id}`).addEventListener('input', scheduleTpPreview)
for (const id of ['tpMinScore', 'tpMaxItems']) $(`#${id}`).addEventListener('change', scheduleTpPreview)
document.querySelectorAll('[data-tp-days]').forEach((b) => b.addEventListener('click', () => {
  const n = +b.dataset.tpDays
  const to = new Date(); const from = new Date(); from.setDate(from.getDate() - n)
  $('#tpFrom').value = n ? dayStr(from) : ''
  $('#tpTo').value = n ? dayStr(to) : ''
  scheduleTpPreview()
}))
// 源多选收起/展开：点头行或输入框展开，点框外或 Esc 收起
const tpSrcListShow = (v) => { $('#tpSrcList').hidden = !v; $('.tp-srcbox').classList.toggle('open', v) }
$('#tpSrcHead').addEventListener('click', (e) => {
  if (e.target.closest('button') || e.target === $('#tpSrcQ')) return // 按钮各自处理；输入框走 focus/click
  tpSrcListShow($('#tpSrcList').hidden) // 点标签/空白区：切换展开态
})
$('#tpSrcQ').addEventListener('focus', () => tpSrcListShow(true))
$('#tpSrcQ').addEventListener('click', () => tpSrcListShow(true))
$('#tpSrcQ').addEventListener('keydown', (e) => { if (e.key === 'Escape') tpSrcListShow(false) })
document.addEventListener('click', (e) => { if (!e.target.closest('.tp-srcbox')) tpSrcListShow(false) })
$('#tpSrcQ').addEventListener('input', () => { tpSrcListShow(true); renderTpSrcs() })
$('#tpSrcAll').addEventListener('click', () => { for (const s of state.sources || []) tpSel.add(s.id); renderTpSrcs(); scheduleTpPreview() })
$('#tpSrcNone').addEventListener('click', () => { tpSel.clear(); renderTpSrcs(); scheduleTpPreview() })
$('#tpSrcList').addEventListener('change', (e) => {
  const c = e.target.closest('.tp-src')
  if (!c) return
  if (c.checked) tpSel.add(c.value); else tpSel.delete(c.value)
  $('#tpSrcCount').textContent = `已选 ${tpSel.size}/${(state.sources || []).length}`
  scheduleTpPreview()
})
$('#btnTpGen').addEventListener('click', async () => {
  const p = tpParams()
  if (!p.keywords.length) return
  const pc = await askPeak(tpEditId ? '专题重生成' : '专题生成') // 高峰三选：now=仍执行/queue=排低峰/cancel=放弃
  if (pc === 'cancel') return
  $('#btnTpGen').disabled = true
  try {
    if (tpEditId) { // 修改专题：保存新设置并同 id 重生成（弹层本身即确认，不再武装）
      const r = await post(`/topics/${encodeURIComponent(tpEditId)}/regen`, { ...p, peakBypass: pc === 'now' })
      $('#topicModal').hidden = true
      toast(r?.peakHeld ? '已排入低峰队列，出峰自动开始' : r?.queued ? '设置已保存——已加入排队，轮到自动重新生成' : '设置已保存，专题开始重新生成')
    } else {
      const r = await post('/topics', { ...p, peakBypass: pc === 'now' })
      $('#topicModal').hidden = true
      state.topicView = 'list'; state.topicId = ''
      toast(r?.peakHeld ? '已排入低峰队列，出峰自动开始' : r?.queued ? '已有专题在生成——已加入排队，轮到自动开始' : '专题已开始生成，进度见上方横幅')
    }
    startTopicWatch(); loadTopicsView()
  } catch (e) {
    $('#tpErr').textContent = e.message; $('#tpErr').hidden = false
    $('#btnTpGen').disabled = false
  }
})

// ---- 快报类型管理：快报列表弹层（增删改/启停）+ 编辑弹层 ----

const btMinSel = $('#btMinute')
if (btMinSel && !btMinSel.options.length) { // 第几分下拉一次成型
  for (let m = 0; m < 60; m++) btMinSel.add(new Option(`:${String(m).padStart(2, '0')}`, String(m)))
}
const btFmtSrcs = (t) => t.sourceIds?.length ? `${t.sourceIds.length} 个源` : '全部启用源'
const btFmtBrief = (t) => [t.scheduleText, btFmtSrcs(t), `评分≥${t.minScore}`, t.maxItems ? `≤${t.maxItems}条` : '', t.keywords?.length ? `关键字×${t.keywords.length}` : '', t.focus ? '有侧重' : ''].filter(Boolean).join(' · ')
const renderBriefTypeList = () => {
  const list = state.briefTypes || []
  $('#btList').innerHTML = list.length ? list.map((t) => `
    <div class="bt-row${t.enabled === false ? ' off' : ''}">
      <label class="bt-en" title="启用/停用该快报"><input type="checkbox" data-bten="${esc(t.id)}" ${t.enabled === false ? '' : 'checked'}></label>
      <div class="bt-main">
        <div class="bt-name" data-btview="${esc(t.id)}" title="关闭弹层并查看该快报">${esc(t.name)}${t.builtin ? ' <i class="bt-builtin">内置</i>' : ''}</div>
        <div class="bt-sub">${esc(btFmtBrief(t))}</div>
      </div>
      <div class="bt-ops">
        <button data-btedit="${esc(t.id)}" title="修改该快报类型">✎ 编辑</button>
        <button class="danger" data-btdel="${esc(t.id)}" title="删除该快报类型（历史快报文件保留）">✕ 删除</button>
      </div>
    </div>`).join('') : '<p class="empty">暂无快报类型——点右下角「＋ 新增快报」创建；或停用全部即不再自动出快报。</p>'
}
async function refreshBriefTypes() { await loadBriefTypes(); renderBriefTypeList() }
$('#btnBriefList').addEventListener('click', async () => {
  $('#btList').innerHTML = '<p class="empty">加载中…</p>'
  $('#briefTypesModal').hidden = false
  await refreshBriefTypes()
})
$('#briefTypesModal').addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target.closest('[data-close]')) $('#briefTypesModal').hidden = true })
/** 弹层直达视图：标题「快报列表」=全部合并视图；行名=该类型单视图——与标题下拉选项等价 */
const btJump = (sel) => { $('#briefTypesModal').hidden = true; state.briefSel = sel; syncRunBtn(); if (state.digestKind === 'hourly') loadDigest() }
$('#btAllView').addEventListener('click', () => btJump('all'))
// 列表行委托：启停 toggle / 点名字跳转 / 编辑 / 删除（删除走 armOnce 二次确认）
$('#btList').addEventListener('click', async (e) => {
  const view = e.target.closest('[data-btview]')
  if (view) { btJump(view.dataset.btview); return }
  const del = e.target.closest('[data-btdel]')
  if (del) {
    if (!armOnce(del, '✕ 删除', '⚠ 确认删除？再点一次')) return
    try { await api(`/brief-types/${encodeURIComponent(del.dataset.btdel)}`, { method: 'DELETE' }) }
    catch (err) { toast(`删除失败: ${err.message}`) }
    await refreshBriefTypes(); if (state.digestKind === 'hourly') loadDigest()
    return
  }
  const ed = e.target.closest('[data-btedit]')
  if (ed) openBriefEditor(ed.dataset.btedit)
})
$('#btList').addEventListener('change', async (e) => {
  const c = e.target.closest('[data-bten]')
  if (!c) return
  try { await api(`/brief-types/${encodeURIComponent(c.dataset.bten)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: c.checked }) }) }
  catch (err) { toast(`保存失败: ${err.message}`); c.checked = !c.checked }
  await refreshBriefTypes() // 下拉同步（停用项标灰）
})
// ---- 编辑弹层：btEditId='' 新增 / <id> 修改 ----
let btEditId = ''
const btSel = new Set() // 源勾选（同 tpSel 模式：过滤重渲不清选择）
const btFreqSync = () => {
  const k = $('#btFreq').value
  $('#btEveryWrap').hidden = k !== 'minutes'
  $('#btMinuteWrap').hidden = k !== 'hourly'
  $('#btTimeWrap').hidden = k !== 'daily'
}
$('#btFreq').addEventListener('change', btFreqSync)
const btSrcListShow = (v) => { $('#btSrcList').hidden = !v; $('#btSrcBox').classList.toggle('open', v) }
function renderBtSrcs() {
  const k = $('#btSrcQ').value.trim().toLowerCase()
  const list = (state.sources || []).filter((s) => !k || s.title.toLowerCase().includes(k) || (s.category || '').toLowerCase().includes(k))
  $('#btSrcList').innerHTML = list.length
    ? list.map((s) => `<label class="tp-src"><input type="checkbox" class="tp-src" value="${esc(s.id)}" ${btSel.has(s.id) ? 'checked' : ''}> ${esc(s.title)}</label>`).join('')
    : '<span class="empty">无匹配源</span>'
  $('#btSrcCount').textContent = `已选 ${btSel.size}/${(state.sources || []).length}`
}
$('#btSrcHead').addEventListener('click', (e) => {
  if (e.target.closest('button') || e.target === $('#btSrcQ')) return
  btSrcListShow($('#btSrcList').hidden)
})
$('#btSrcQ').addEventListener('focus', () => btSrcListShow(true))
$('#btSrcQ').addEventListener('click', () => btSrcListShow(true))
$('#btSrcQ').addEventListener('keydown', (e) => { if (e.key === 'Escape') btSrcListShow(false) })
$('#btSrcQ').addEventListener('input', () => { btSrcListShow(true); renderBtSrcs() })
$('#btSrcAll').addEventListener('click', () => { for (const s of state.sources || []) btSel.add(s.id); renderBtSrcs() })
$('#btSrcNone').addEventListener('click', () => { btSel.clear(); renderBtSrcs() })
$('#btSrcList').addEventListener('change', (e) => {
  const c = e.target.closest('.tp-src')
  if (!c) return
  if (c.checked) btSel.add(c.value); else btSel.delete(c.value)
  $('#btSrcCount').textContent = `已选 ${btSel.size}/${(state.sources || []).length}`
})
document.addEventListener('click', (e) => { if (!e.target.closest('#btSrcBox')) btSrcListShow(false) })
function openBriefEditor(id) {
  const t = id ? (state.briefTypes || []).find((x) => x.id === id) : null
  if (id && !t) return toast('快报类型不存在')
  btEditId = t?.id || ''
  $('#btEditTitle').textContent = t ? `修改快报·${t.name}` : '新增快报'
  $('#btName').value = t?.name || ''
  const s = t?.schedule || { kind: 'minutes', everyMinutes: 60 }
  $('#btFreq').value = s.kind
  $('#btEvery').value = s.kind === 'minutes' ? s.everyMinutes : 60
  $('#btMinute').value = String(s.kind === 'hourly' ? s.minute : 0)
  $('#btTime').value = s.kind === 'daily' ? s.time : '08:00'
  btFreqSync()
  $('#btMinScore').value = String(t?.minScore ?? 6)
  $('#btMaxItems').value = t?.maxItems ? String(t.maxItems) : '' // 0=不限→留空显示占位，不给用户看一个"0"
  $('#btKeywords').value = (t?.keywords || []).join(' ')
  $('#btFocus').value = t?.focus || ''
  $('#btEnabled').checked = t?.enabled !== false
  btSel.clear()
  if (t?.sourceIds?.length) for (const sid of t.sourceIds) btSel.add(sid)
  else for (const src of state.sources || []) btSel.add(src.id) // 空=全部源→视觉全选；保存时全选归一化回空（跟随新增源）
  $('#btSrcQ').value = ''
  btSrcListShow(false); renderBtSrcs()
  $('#btErr').hidden = true
  $('#briefEditModal').hidden = false
  $('#btName').focus()
}
$('#btnBtNew').addEventListener('click', () => openBriefEditor(''))
$('#briefEditModal').addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target.closest('[data-close]')) $('#briefEditModal').hidden = true })
$('#btnBtSave').addEventListener('click', async () => {
  const name = $('#btName').value.trim()
  if (!name) { $('#btErr').textContent = '快报名称不能为空'; $('#btErr').hidden = false; return }
  const freq = $('#btFreq').value
  const schedule = freq === 'hourly' ? { kind: 'hourly', minute: +$('#btMinute').value || 0 }
    : freq === 'daily' ? { kind: 'daily', time: $('#btTime').value || '08:00' }
    : { kind: 'minutes', everyMinutes: Math.max(5, +$('#btEvery').value || 60) }
  const total = (state.sources || []).length
  const body = {
    name, schedule,
    sourceIds: (btSel.size === 0 || btSel.size === total) ? [] : [...btSel], // 全选/全不选→空=全部启用源（新加的源自动纳入）
    minScore: +$('#btMinScore').value || 0,
    maxItems: Math.max(0, Math.floor(+$('#btMaxItems').value || 0)),
    keywords: $('#btKeywords').value.split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean).slice(0, 10),
    focus: $('#btFocus').value.trim(),
    enabled: $('#btEnabled').checked,
  }
  $('#btnBtSave').disabled = true
  try {
    if (btEditId) await api(`/brief-types/${encodeURIComponent(btEditId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    else await post('/brief-types', body)
    $('#briefEditModal').hidden = true
    toast(btEditId ? '快报类型已保存' : '快报类型已创建')
    await refreshBriefTypes()
    if (state.digestKind === 'hourly') loadDigest()
  } catch (e) {
    $('#btErr').textContent = e.message; $('#btErr').hidden = false
  } finally { $('#btnBtSave').disabled = false }
})

// 抓取管线（抓取/翻译/评分/快报）进度文案：stage 分段 + done/total + 当前源域名；cancelled 时显示停止中
const fmtEta = (ms) => { // etaMs→人话；无样本不显示
  if (ms == null || ms <= 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 8) return ' · 即将完成'
  if (s < 90) return ` · 约剩 ${s} 秒`
  return ` · 约剩 ${Math.round(s / 60)} 分钟`
}
const PURPOSE_ZH = { 'topic-chunk': '批小结', 'topic-merge': '合并成文', 'topic-title': '专题起名', translate: '翻译', score: '评分', brief: '快报概括', cluster: '聚类', 'item-summary': '条目摘要', 'digest-prose': '日报成文', judge: '正文判定', classify: '分类' }
const fmtQDesc = (list) => { // purpose 列表聚合成「翻译×3、评分×2」
  if (!list?.length) return ''
  const c = new Map()
  for (const p of list) c.set(p, (c.get(p) ?? 0) + 1)
  return [...c].map(([p, n]) => `${PURPOSE_ZH[p] ?? p}${n > 1 ? `×${n}` : ''}`).join('、')
}
const fmtQueue = (q) => { // 全局 AI 队列：本任务有调用在等锁时点名排队及明细（并发=1 常见——别的管线正占着模型）
  if (!q || !q.tagQueued) return ''
  if (q.tagRunning) {
    const d = fmtQDesc(q.mineQueued)
    return ` · ${q.tagQueued} 个调用排队中${d ? `（${d}）` : ''}`
  }
  const d = fmtQDesc(q.ahead)
  return ` · 排队等待 AI（前方 ${q.tagAhead} 个调用${d ? `：${d}` : ''}）`
}
const fetchProgText = (p, prefix = '') => {
  const st = p.cancelled ? '停止中' : stageZh(p.stage) || '抓取中' // ''→抓取中；judge/score/translate 各自有名
  let cur = ''
  try { if (p.current) cur = ` · ${new URL(p.current).hostname}` } catch { /* 畸形 URL 不显示 */ }
  return `⏳ ${prefix}${st}…${p.total ? ` (${p.done}/${p.total})` : ''}${cur}${fmtEta(p.etaMs)}${fmtQueue(p.queue)}${taskSfx(p.taskWaiting)}`
}
// 日报生成进度轮询：手动点击与 iframe 重挂后的状态恢复共用
function startDigestWatch(reset) {
  let seenRun = false
  const dp = setInterval(async () => {
    try {
      const p = await api('/digest-progress')
      if (p.running) { seenRun = true; const stage = stageZh(p.stage) === p.stage ? '日报生成中' : stageZh(p.stage); busyShow('digest', `⏳ ${stage}…${p.total ? ` (${p.done}/${p.total})` : ''}${fmtEta(p.etaMs)}${fmtQueue(p.queue)}${taskSfx(p.taskWaiting)}`); return }
      if (p.queued) { busyShow('digest', p.held ? `⌛ 高峰暂停中·出峰自动执行…${taskSfx(p.taskWaiting)}` : `⌛ 日报排队中…${taskSfx(p.taskWaiting)}`); return } // 全局队列等位中（held=高峰挂起）
      clearInterval(dp); busyDone('digest'); reset(); toast(seenRun ? (p.cancelled ? '已按请求停止' : '日报生成完成') : '已取消排队'); loadDigest()
    } catch { /* 进度不可达不影响生成 */ }
  }, 900)
  return dp
}
// iframe 重挂后恢复：state.generating 归零但后端还在跑——探测一次，在跑就恢复生成中 UI 续轮询
async function resumeDigestIfRunning() {
  try {
    // 快报/定时抓取管线：与日报共用 busy 条+停止键（停止键按在跑管线分别走 /fetch-cancel、/digest-stop）
    const f = await api('/fetch-progress').catch(() => null)
    if (f?.running || f?.queued) { // 在跑或在全局队列等位都算活着——排队中也要显示状态
      $('#btnDigestStop').hidden = false
      busyShow('fetch', f.queued && !f.running ? (f.held ? '⌛ 高峰暂停中·出峰自动执行…' : '⌛ 抓取+评分排队中…') : fetchProgText(f))
      startSlotWatch('抓取已完成') // 统一走共享 watcher：running/queued/held 三态全覆盖（在跑时 busyShow 内部按优先级挡掉，不与 digest/topic 互踩）
    }
    const p = await api('/digest-progress')
    if (!p.running && !p.queued) return
    const btn = $('#btnDigestRun')
    btn.disabled = true; btn.hidden = true
    $('#btnDigestStop').hidden = false
    $('#digestBusy').hidden = false
    const reset = () => { state.generating = false; btn.disabled = false; btn.hidden = false; $('#btnDigestStop').hidden = true; $('#digestBusy').hidden = true }
    state.generating = true
    const dp = startDigestWatch(reset)
    $('#digestBusy').textContent = p.queued && !p.running ? (p.held ? '⌛ 高峰暂停中·出峰自动执行…' : '⌛ 日报排队中…') : '⏳ 日报生成中…'
  } catch { /* 探测失败按未运行 */ }
  // 专题生成跨重挂恢复：在跑或在排则续接进度轮询+停止键
  try {
    const tp = await api('/topic-progress')
    if (tp?.running || (tp?.queuedIds || []).length) startTopicWatch()
  } catch { /* 同上 */ }
}
resumeDigestIfRunning()

$('#btnDigestRun').addEventListener('click', async () => {
  const btn = $('#btnDigestRun')
  const isBrief = state.digestKind === 'hourly'
  const pc = await askPeak(isBrief ? '快报生成' : '日报生成') // 高峰三选：now=仍执行/queue=排低峰/cancel=放弃（非高峰直接 now）
  if (pc === 'cancel') return
  btn.disabled = true; btn.hidden = true // 生成中隐藏入口，防重入
  $('#btnDigestStop').hidden = false
  $('#digestBusy').hidden = false
  const reset = () => { state.generating = false; btn.disabled = false; btn.hidden = false; $('#btnDigestStop').hidden = true; $('#digestBusy').hidden = true }
  state.generating = true
  const dp = startDigestWatch(reset)
  // 生成始终针对今天：跨零点时日期框可能还停在昨天（日报回退改的），先拨回本地当天——日报/快报共用
  $('#digestDay').value = dayStr(new Date())
  if (isBrief) { // 快报=独立任务：只抓该类型所选源，跑完直接写节；全部=各启用类型依次各跑一次
    clearInterval(dp)
    const tname = state.briefSel === 'all' ? '全部快报' : (state.briefTypes.find((t) => t.id === state.briefSel)?.name || '快报')
    $('#digestBusy').textContent = `⏳ ${tname} 生成中…（抓取+评分）`
    try {
      const r = await post('/brief-run', { type: state.briefSel, peakBypass: pc === 'now', holdInPeak: pc === 'queue' })
      if (pc === 'queue' || r?.queued || r?.merged) { // 高峰挂起/队列等位/合并进在跑任务——排队即释放按钮；merged 停止键保留（在跑仍可停），queued 收起（还没在跑）
        state.generating = false; btn.disabled = false; btn.hidden = false; $('#btnDigestStop').hidden = !r?.merged; $('#digestBusy').hidden = true
        toast(pc === 'queue' || r?.queued ? '已排队，轮到自动开始（高峰则出峰后执行；悬停忙条可取消）' : '已有同类任务在跑——请求已合并，跑完自动出快报')
        startSlotWatch('快报已生成')
        return
      }
      toast('已开始抓取+评分，快报稍后生成')
      let seenRun = false // 没跑过就结束 = 排队中被撤——toast 分文案
      const poll = setInterval(async () => {
        try {
          const p = await api('/fetch-progress')
          if (p.running) { seenRun = true; busyShow('fetch', fetchProgText(p, '快报生成·')); return }
          if (p.queued) { busyShow('fetch', p.held ? `⌛ 高峰暂停中·出峰自动执行…${taskSfx(p.taskWaiting)}` : `⌛ 快报任务排队中…${taskSfx(p.taskWaiting)}`); return }
          clearInterval(poll); busyDone('fetch'); reset(); toast(seenRun ? (p.cancelled ? '已按请求停止' : '快报已生成') : '已取消排队'); loadDigest()
        } catch { /* 进度不可达不阻塞 */ }
      }, 1500) // 无超时上限：抓取+评分远超 2min——挂到真正结束才收尾，期间停止键可取消
    } catch (e) { toast(`生成失败: ${e.message}`); reset() }
    return
  }
  $('#digestBusy').textContent = '⏳ 日报生成中…（LLM 总结可能要几分钟）' // 忙文走 busybar，statusbar 保持状态行
  try {
    // 异步触发：大条数下 LLM 全链路远超 HTTP 请求超时，服务端立即返回，轮询收尾
    // day 不传：服务端 zonedDayKey(config.timezone) 自算"今天"——选择框是查看过滤器，不是生成目标
    await post('/digest-run', { force: true, peakBypass: pc === 'now' })
    toast(pc === 'queue' ? '已排入低峰队列，出峰自动生成日报' : '已开始生成，进度见上方横幅')
  } catch (e) { toast(`生成失败: ${e.message}`); clearInterval(dp); reset() }
})
let retryPoll = 0
async function refreshRetryBtn() {
  const btn = $('#btnRetryAll')
  try {
    const p = await api('/fetch-progress')
    if (p.running) btn.textContent = `重试中(${p.done}/${p.total})`
    else if (p.queued) btn.textContent = '排队中…'
    else { btn.textContent = '↻ 重试全部失败源'; if (retryPoll) { clearInterval(retryPoll); retryPoll = 0 } loadSources(); loadStatus() }
  } catch { btn.textContent = '↻ 重试全部失败源' }
}
$('#btnRetryAll').addEventListener('click', async () => {
  try {
    const p = await api('/fetch-progress')
    if (p.running || p.queued) { await post('/fetch-cancel', {}); toast('已请求取消，在飞的源收尾后停止'); return }
  } catch { /* progress 不可达则按未运行处理 */ }
  toast('重试全部失败源中…')
  retryPoll = setInterval(refreshRetryBtn, 800)
  try {
    await post('/fetch', { force: true, onlyFailed: true })
    toast('已开始重试，完成后自动刷新')
    loadSources(); loadStatus()
  } catch (e) { toast(`重试失败: ${e.message}`) }
  finally { if (retryPoll) { clearInterval(retryPoll); retryPoll = 0 } $('#btnRetryAll').textContent = '↻ 重试全部失败源' }
})
$('#btnDigestStop').addEventListener('click', async () => {
  // 停止键对在跑管线分别生效：抓取/翻译/评分/快报 → /fetch-cancel，日报 → /digest-stop，专题 → /topic-stop；都在跑则都停
  try {
    const [f, d, tp] = await Promise.all([api('/fetch-progress').catch(() => null), api('/digest-progress').catch(() => null), api('/topic-progress').catch(() => null)])
    if (!f?.running && !d?.running && !tp?.running) { toast(f?.queued || d?.queued || (tp?.queuedIds || []).length ? '任务在排队中——悬停忙条进队列弹层可取消' : '当前没有正在运行的任务'); return }
    const names = []
    if (f?.running) { try { await post('/fetch-cancel', {}); names.push('抓取/评分') } catch { /* 单条失败不挡另一条 */ } }
    if (d?.running) { try { await post('/digest-stop', {}); names.push('日报生成') } catch { /* 同上 */ } }
    if (tp?.running) { try { await post('/topic-stop', {}); names.push('专题生成') } catch { /* 同上 */ } }
    toast(names.length ? `已请求停止${names.join('、')}，在飞的调用收尾后结束` : '停止请求失败')
  } catch (e) { toast(`停止失败: ${e.message}`) }
})

// ---- 订阅源管理 ----

async function loadSources() {
  try {
    const r = await api('/sources')
    state.sources = r.sources
    state.deletedBuiltins = r.deletedBuiltins || []
    renderSources()
    fillFilters(r.sources)
  } catch (e) { $('#srcList').innerHTML = `<p class="err">${esc(e.message)}</p>` }
}

function renderDeletedSrcs() {
  const del = state.deletedBuiltins || []
  return del.length ? `<div class="src-del-zone"><h4>已删除的内置源</h4>${del.map((u) =>
    `<div class="src"><div class="src-info"><b>${esc(u)}</b></div><div class="src-actions"><button data-src-act="restore" data-id="${esc(u)}">↩ 恢复</button></div></div>`).join('')}</div>` : ''
}
function renderSources() {
  const cats = [...new Set(state.sources.map((x) => x.category).filter(Boolean))]
  $('#newSrcCat').innerHTML = '<option value="">分类…</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('') + '<option value="__new">＋ 自定义…</option>'
  $('#srcList').innerHTML = state.sources.map((s) => `
    <div class="src-wrap">
    <div class="src ${s.enabled ? '' : 'off'}">
      <div class="src-info">
        <b>${esc(s.title)}</b> <span class="tag">${esc(s.category)}</span>${s.builtin ? '<span class="tag dim">内置</span>' : ''}
        <div class="src-url">${esc(s.url)}</div>
        ${s.health?.lastError ? `<div class="src-err">✗ ${esc(s.health.lastError)}${s.health.cooldownUntil ? ' · 冷却中' : ''}</div>` : `<div class="src-ok">✓ ${s.health?.ok || 0} 次成功${s.health?.avgMs ? ` · ${Math.round(s.health.avgMs)}ms` : ''}</div>`}
      </div>
      <div class="src-actions">
        <button data-src-act="retry" data-id="${esc(s.url)}" title="${s.health?.lastError || s.health?.cooldownUntil ? '复活并重试该源' : '立即抓取该源'}">${s.health?.lastError || s.health?.cooldownUntil ? '↻ 重试' : '↻ 抓取'}</button>
        <button data-src-act="toggle" data-id="${esc(s.url)}" data-en="${s.enabled ? 0 : 1}">${s.enabled ? '停用' : '启用'}</button>
        <button data-src-act="sum" data-id="${esc(s.url)}" data-sum="${s.summarize !== false ? 0 : 1}" title="该源条目是否生成 AI 摘要">${s.summarize !== false ? '摘要✓' : '摘要✗'}</button>
        <button data-src-act="edit" data-id="${esc(s.url)}" title="编辑源属性">⚙ 编辑</button>
        <button data-src-act="del" data-id="${esc(s.url)}" title="${s.builtin ? '删除内置源(可在下方已删区恢复)' : '删除该源'}">删除</button>
      </div>
    </div>
    ${state.editing === s.url ? `
    <div class="src-edit">
      <label class="wide">URL <input data-f="url" value="${esc(s.url)}"></label>
      <label>名称 <input data-f="title" value="${esc(s.title)}"></label>
      <label>分类 <select data-f="category"><option value="">无分类</option>${[...new Set([s.category, ...state.sources.map((x) => x.category)].filter(Boolean))].map((c) => `<option ${c === s.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="__new">＋ 自定义…</option></select><input data-f="categoryNew" placeholder="新分类名" hidden></label>
      <label><input type="checkbox" data-f="enabled" ${s.enabled ? 'checked' : ''}> 启用</label>
      <label><input type="checkbox" data-f="summarize" ${s.summarize !== false ? 'checked' : ''}> AI 摘要</label>
      <label><input type="checkbox" data-f="useProxy" ${s.proxy === true || typeof s.proxy === 'string' ? 'checked' : ''}> 使用代理</label>
      <label>最小冷却小时 <input type="number" min="0" step="1" data-f="cooldownHours" value="${s.cooldownHours ?? ''}" placeholder="24"></label>
      <button data-src-act="cancel" data-id="${esc(s.url)}">完成</button>
    </div>` : ''}
    </div>`).join('') + renderDeletedSrcs()
}

document.addEventListener('change', (e) => { // 分类选「＋自定义…」时换出输入框
  const sel = e.target
  if (sel.tagName !== 'SELECT' || sel.value !== '__new') return
  sel.hidden = true
  const inp = sel.parentElement.querySelector(sel.id === 'newSrcCat' ? '#newSrcCatNew' : 'input[data-f=categoryNew]')
  if (!inp) return
  inp.hidden = false; inp.focus()
  const back = () => { if (!inp.value.trim()) { inp.hidden = true; inp.value = ''; sel.hidden = false; sel.value = '' } }
  inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') back() }, { once: true })
  inp.addEventListener('blur', back, { once: true })
})
// 源编辑自动生效:编辑面板内字段 change 即 PATCH,面板保持打开
$('#srcList').addEventListener('change', debounce(async (e) => {
  const panel = e.target.closest('.src-edit')
  if (!panel || !e.target.matches('[data-f]')) return
  const id = panel.querySelector('button[data-src-act=cancel]')?.dataset.id || e.target.closest('[data-id]')?.dataset.id
  const g = (n) => panel.querySelector(`[data-f="${n}"]`)
  try {
    await api(`/sources/${encodeURIComponent(g('url')?.value.trim() || '')}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      url: g('url').value.trim() || undefined,
      title: g('title').value.trim() || undefined,
      category: g('categoryNew').value.trim() || g('category').value || undefined,
      enabled: g('enabled').checked,
      summarize: g('summarize').checked,
      proxy: g('useProxy').checked ? true : false,
      cooldownHours: g('cooldownHours').value === '' ? null : Number(g('cooldownHours').value),
    }) })
    toast('源已自动保存')
  } catch (err) { toast(`保存失败: ${err.message}`) }
}, 500))

$('#srcList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-src-act]')
  if (!btn) return
  const id = encodeURIComponent(btn.dataset.id)
  try {
    if (btn.dataset.srcAct === 'toggle') {
      await api(`/sources/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: btn.dataset.en === '1' }) })
    } else if (btn.dataset.srcAct === 'retry') {
      toast('已开始抓取该源（含翻译/评分，稍后自动刷新）…')
      await api(`/sources/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'retry' }) })
      const poll = setInterval(async () => {
        try {
          const p = await api('/fetch-progress')
          if (!p.running) {
            clearInterval(poll); loadSources(); loadStatus()
            const s2 = (await api('/sources')).sources.find((x) => encodeURIComponent(x.url) === id)
            toast(s2?.health?.lastError ? `仍失败: ${s2.health.lastError.slice(0, 60)}` : `已恢复: ✓ ${s2?.health?.ok ?? 0} 次成功`)
          }
        } catch { /* 进度不可达不阻塞 */ }
      }, 1500)
      setTimeout(() => clearInterval(poll), 180_000) // 3min 兜底
    } else if (btn.dataset.srcAct === 'restore') {
      await api(`/sources/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'restore' }) })
      toast('已恢复内置源')
    } else if (btn.dataset.srcAct === 'sum') {
      await api(`/sources/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ summarize: btn.dataset.sum === '1' }) })
    } else if (btn.dataset.srcAct === 'edit') {
      state.editing = state.editing === btn.dataset.id ? null : btn.dataset.id; renderSources(); return
    } else if (btn.dataset.srcAct === 'cancel') {
      state.editing = null; renderSources(); return
    } else if (btn.dataset.srcAct === 'save') {
      const panel = btn.closest('.src-edit')
      const g = (n) => panel.querySelector(`[data-f="${n}"]`)
      await api(`/sources/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        url: g('url').value.trim() || undefined,
        title: g('title').value.trim() || undefined,
        category: g('categoryNew').value.trim() || g('category').value || undefined,
        enabled: g('enabled').checked,
        summarize: g('summarize').checked,
        proxy: g('useProxy').checked ? true : false,
        cooldownHours: g('cooldownHours').value === '' ? null : Number(g('cooldownHours').value),
      }) })
      state.editing = null; toast('已保存')
    } else {
      await api(`/sources/${id}`, { method: 'DELETE' })
    }
    loadSources()
  } catch (err) { toast(`操作失败: ${err.message}`) }
})
// 代理是「使用/不使用」单选框——勾选后走设置页的全局代理（config.fetch.proxyUrl 或此处 prefs.proxyUrl）

const showAddErr = (msg) => { const el = $('#addSrcErr'); el.textContent = msg; el.hidden = !msg }
$('#btnAddSrcOpen').addEventListener('click', () => { showAddErr(''); srcPreview = null; $('#srcPreview').hidden = true; $('#btnAddSrcConfirm').hidden = true; $('#addSrcModal').hidden = false; $('#newSrcUrl').focus() })
$('#addSrcModal').addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target.closest('[data-close]')) $('#addSrcModal').hidden = true })
let srcPreview = null // {url,title,category,items}
let srcPreviewTimer = null
const resetSrcPreview = () => { srcPreview = null; $('#srcPreview').hidden = true; $('#btnAddSrcConfirm').hidden = true; clearInterval(srcPreviewTimer); srcPreviewTimer = null }
$('#newSrcUrl').addEventListener('input', resetSrcPreview) // 换网址=换对象，旧预览立即作废
$('#btnAddSrc').addEventListener('click', async () => { // 测试：抓 feed 预览不落库
  const url = $('#newSrcUrl').value.trim()
  if (!url) return showAddErr('请输入 feed URL')
  showAddErr('校验并抓取预览中…'); $('#srcPreview').hidden = true; $('#btnAddSrcConfirm').hidden = true
  try {
    const pv = await post('/sources/preview', { url, title: $('#newSrcTitle').value.trim() || undefined, category: $('#newSrcCatNew').value.trim() || $('#newSrcCat').value || undefined })
    srcPreview = pv
    $('#srcPreview').innerHTML = `<div class="pv-head">✓ ${esc(pv.title)}${pv.category ? ` · ${esc(pv.category)}` : ''}${pv.viaProxy ? ' · 代理' : ''}</div>`
      + pv.items.map((i) => `<div class="pv-item">· ${i.link ? `<a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : esc(i.title)}</div>`).join('')
      + `<div class="pv-count">共 ${pv.items.length} 条示例（实际条目更多）</div>`
    $('#srcPreview').hidden = false
    // 5 秒倒计时后自动添加；期间可点按钮立即确认，或改网址取消
    let n = 5
    const cf = $('#btnAddSrcConfirm')
    cf.textContent = `自动添加 (${n}s)`; cf.hidden = false
    clearInterval(srcPreviewTimer)
    srcPreviewTimer = setInterval(() => {
      n -= 1
      if (n <= 0) { clearInterval(srcPreviewTimer); srcPreviewTimer = null; cf.click(); return }
      cf.textContent = `自动添加 (${n}s)`
    }, 1000)
    showAddErr('')
  } catch (e) { resetSrcPreview(); showAddErr(`预览失败: ${e.message}`) }
})
$('#btnAddSrcConfirm').addEventListener('click', async () => { // 确认：真正写入源
  if (!srcPreview) return
  clearInterval(srcPreviewTimer); srcPreviewTimer = null
  showAddErr('添加中…')
  try {
    const r = await post('/sources', { url: srcPreview.url, title: $('#newSrcTitle').value.trim() || srcPreview.title, category: srcPreview.category })
    $('#newSrcUrl').value = ''; $('#newSrcTitle').value = ''; $('#srcPreview').hidden = true; $('#btnAddSrcConfirm').hidden = true; $('#addSrcModal').hidden = true
    srcPreview = null
    toast(`已添加${r?.source ? ` · ${r.source.title}` : ''}`); loadSources()
  } catch (e) { resetSrcPreview(); showAddErr(`添加失败: ${e.message}`) }
})

$('#btnOpmlExport').addEventListener('click', async () => {
  try {
    const t = await (await fetch(`${API}/opml`)).text()
    if (window.showSaveFilePicker) { // Electron guest 禁下载但支持 FS Access 原生保存对话框
      try {
        const h = await window.showSaveFilePicker({ suggestedName: `dsh-rss-news-daily-sources-${new Date().toISOString().slice(0, 10)}.opml`, types: [{ description: 'OPML 订阅清单', accept: { 'text/xml': ['.opml', '.xml'] } }] })
        const w = await h.createWritable(); await w.write(t); await w.close()
        toast('已导出'); return
      } catch (e) { if (e?.name === 'AbortError') return }
    }
    await navigator.clipboard.writeText(t)
    const r2 = await post('/opml-export', {})
    toast(`已导出到 ${r2.path}（OPML 也已复制到剪贴板）`)
  } catch (e) { toast(`导出失败: ${e.message}`) }
})
$('#opmlFile').addEventListener('change', async (e) => {
  const f = e.target.files?.[0]
  if (!f) return
  const opml = await f.text()
  toast('导入中…')
  try {
    const r = await post('/opml', { opml })
    toast(`导入完成: +${r.added} 新增 / ${r.duplicated} 重复 / ${r.skipped} 跳过`)
    loadSources()
  } catch (err) { toast(`导入失败: ${err.message}`) }
})

function fillFilters(sources) {
  const cats = [...new Set(sources.map((s) => s.category).filter(Boolean))]
  $('#category').innerHTML = '<option value="">全部分类</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('')
  $('#srcFilter').innerHTML = '<option value="">全部源</option>' + sources.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('')
}

// ---- 调教 ----

async function loadPrefs() {
  try {
    const r = await api('/prefs')
    state.prefs = r.prefs
    applyFontSize() // 字号缩放跟 prefs 走：启动/进设置页都重放一遍
    applyWide() // 适应宽屏同理
    renderPrefs()
    renderPriceInputs(); renderStats() // 单价回填 + 费用列按最新单价重算
    $('#proxyUrl').value = r.prefs.proxyUrl || ''
    const d = r.prefs.digestOpts || {}
    for (const [id, k] of [['dItems','digestItems'],['dPerTopic','perTopicLimit'],['dMinScore','minLlmScore'],['dScoreN','llmScoreCandidates'],['dCandH','candidateHours'],['dSumN','summaryMaxItems'],['dConc','summaryConcurrency'],['dSumLen','digestMaxLength'],['dRetDays','retentionDays'],['dMaxItems','storeMaxItems']]) $(`#${id}`).value = d[k] ?? ''
    $('#dLlmConc').value = r.prefs.llmConcurrency ?? '' // 全局 AI 并发（顶层 pref，不走 digestOpts）
    $('#dScoreFetch').checked = d.scoreOnFetch !== false
    $('#dRescore').checked = d.rescoreMissing !== false
    $('#dPruneQ').checked = d.pruneLowQuality !== false
    $('#stubZh').value = r.prefs.stubLimits?.zh ?? ''
    $('#stubEn').value = r.prefs.stubLimits?.en ?? ''
    $('#stubList').value = (r.prefs.contentBlocklist || []).join('\n')
    const pk = r.prefs.peak || {}
    $('#peakEnabled').checked = pk.enabled === true
    $('#peakStart').value = pk.start || ''
    $('#peakEnd').value = pk.end || ''
    $('#peakBrief').checked = pk.brief === true
    renderPeakInfo()
    renderSubTopics(r.prefs)
  } catch { /* ignore */ }
}
// 高峰时段设置：enabled/start/end/brief 一体提交；后端 peakChanged 重挂边界定时器，峰外立即放行补跑
const savePeak = async () => {
  try {
    const r = await post('/prefs', { peak: { enabled: $('#peakEnabled').checked, start: $('#peakStart').value || undefined, end: $('#peakEnd').value || undefined, brief: $('#peakBrief').checked } })
    state.prefs = r.prefs
    toast('高峰设置已保存')
    loadStatus() // 立即刷新 state.peak——状态行/弹层判断用最新峰谷
  } catch (e) { toast(`保存失败: ${e.message}`) }
}
for (const id of ['peakEnabled', 'peakBrief', 'peakStart', 'peakEnd']) $(`#${id}`)?.addEventListener('change', savePeak)
const saveProxy = async () => {
  try {
    await post('/prefs', { proxyUrl: $('#proxyUrl').value.trim() || undefined })
    toast('全局代理已保存')
  } catch (e) { toast(`保存失败: ${e.message}`) }
}
$('#proxyUrl').addEventListener('input', debounce(saveProxy))
const saveDigestOpts = async () => {
  const num = (id) => { const v = $(`#${id}`).value.trim(); return v === '' ? undefined : Number(v) }
  try {
    const r = await post('/prefs', { digestOpts: { digestItems: num('dItems'), perTopicLimit: num('dPerTopic'), minLlmScore: num('dMinScore'), llmScoreCandidates: num('dScoreN'), candidateHours: num('dCandH'), summaryMaxItems: num('dSumN'), summaryConcurrency: num('dConc'), digestMaxLength: num('dSumLen'), scoreOnFetch: $('#dScoreFetch').checked, rescoreMissing: $('#dRescore').checked, retentionDays: num('dRetDays'), pruneLowQuality: $('#dPruneQ').checked, storeMaxItems: num('dMaxItems') } })
    state.prefs = r.prefs
    toast('参数已保存')
  } catch (e) { toast(`保存失败: ${e.message}`) }
}
for (const id of ['dItems', 'dPerTopic', 'dMinScore', 'dScoreN', 'dCandH', 'dSumN', 'dConc', 'dSumLen', 'dRetDays', 'dMaxItems']) $(`#${id}`)?.addEventListener('input', debounce(saveDigestOpts))
for (const id of ['dScoreFetch', 'dRescore', 'dPruneQ']) $(`#${id}`)?.addEventListener('change', saveDigestOpts)
// AI 并发数是顶层 pref：独立保存，空=清覆盖回默认 1
$('#dLlmConc')?.addEventListener('input', debounce(async () => {
  const v = $('#dLlmConc').value.trim()
  try {
    const r = await post('/prefs', { llmConcurrency: v === '' ? null : Number(v) })
    state.prefs = r.prefs || state.prefs
    toast('AI 调用并发数已保存')
  } catch (e) { toast(`保存失败: ${e.message}`) }
}))
function renderSubTopics(p) {
  const cats = [...new Set((state.sources || []).map((src) => src.category).filter(Boolean))].sort()
  const subs = p?.subscribedTopics // undefined=全订阅
  $('#subTopics').innerHTML = cats.length ? cats.map((c) =>
    `<label><input type="checkbox" class="subTopic" value="${esc(c)}" ${!subs || subs.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('')
    : '<span class="empty">暂无分类</span>'
}
const saveSubTopics = async () => {
  const checked = [...document.querySelectorAll('.subTopic')].filter((c) => c.checked).map((c) => c.value)
  const all = checked.length === document.querySelectorAll('.subTopic').length
  try {
    const r = await post('/prefs', { subscribedTopics: all ? [] : checked })
    state.prefs = r.prefs
    toast(all ? '已订阅全部分类' : `已订阅 ${checked.length} 个分类`)
  } catch (e) { toast(`保存失败: ${e.message}`) }
}
$('#subTopics').addEventListener('change', saveSubTopics) // 委托:动态复选框
// 无效内容过滤：阈值 + 名单一起存；后端保存后自动回扫存量（新词条命中的短正文条目立刻隐藏）
const saveStubCfg = async () => {
  const num = (id) => { const v = $(`#${id}`).value.trim(); const n = Number(v); return v === '' || !Number.isFinite(n) ? undefined : Math.max(1, Math.floor(n)) }
  const list = [...new Set($('#stubList').value.split('\n').map((s) => s.trim()).filter(Boolean))]
  try {
    const r = await post('/prefs', { stubLimits: { zh: num('stubZh'), en: num('stubEn') }, contentBlocklist: list })
    state.prefs = r.prefs
    toast(`已保存（名单 ${list.length} 条）`)
  } catch (e) { toast(`保存失败: ${e.message}`) }
}
$('#btnStubSave').addEventListener('click', saveStubCfg)
for (const id of ['stubZh', 'stubEn']) $(`#${id}`).addEventListener('input', debounce(saveStubCfg)) // 阈值即改即存；名单文本量大仍走「保存」钮
$('#btnFetchTest').addEventListener('click', async () => {
  const out = $('#fetchTestOut')
  out.hidden = false; out.textContent = '测试中…'
  try {
    const u = encodeURIComponent($('#testUrl').value.trim())
    const p = $('#testProxy').checked ? '1' : '0'
    const r = await api(`/fetch-test?url=${u}&proxy=${p}`)
    out.textContent = r.error ? `失败: ${r.error}` : `status ${r.status}\n${r.body || ''}`
  } catch (e) { out.textContent = `请求失败: ${e.message}` }
})

// 权重面板:结构化编辑——三段行式(名称×权重+✕删+＋增) + 屏蔽词chip,保存统一落盘
const WT_TABLES = [['topics', '主题'], ['keywords', '关键词'], ['sourceWeight', '源权重']]
function renderPrefs() {
  const p = state.prefs || {}
  const sec = (table, label) => {
    const rows = Object.entries(p[table] || {}).map(([k, v]) =>
      `<div class="pref"><b>${esc(k)}</b> × <input type="number" step="0.05" min="0" data-wt="${table}" data-k="${esc(k)}" value="${v}" style="width:70px"> <button data-wt-del="${table}" data-k="${esc(k)}" title="删除该权重">✕</button></div>`).join('')
    return `<h4>${label}</h4>${rows}<div class="pref"><input data-wt-new="${table}" placeholder="新增${label}名" style="width:140px"> <button data-wt-add="${table}">＋</button></div>`
  }
  const bans = (p.bannedKeywords || []).map((k) =>
    `<span class="pref ban" data-ban-live="${esc(k)}"><b>${esc(k)}</b> <button data-ban-del="${esc(k)}" title="解除屏蔽">✕</button></span>`).join('')
  const hist = (p.tuningHistory || []).slice(-5)
  $('#prefsView').innerHTML = WT_TABLES.map(([t, l]) => sec(t, l)).join('')
    + `<h4>屏蔽词</h4>${bans}<div class="pref"><input id="banNew" placeholder="新增屏蔽词" style="width:140px"> <button id="banAdd">＋</button></div>`
    + '<p class="hint" style="margin-top:8px">修改自动生效</p>'
    + (hist.length ? '<h4>最近调教</h4>' + hist.map((h) => `<div class="hist">${esc(h.at?.slice(0, 16))} — ${esc(h.text)} <i>${(h.actions || []).join('; ')}</i></div>`).join('') : '')
}
// 采集面板当前编辑值（加删前收割，保住未保存的输入）
const harvestWeights = () => {
  const w = { topics: {}, keywords: {}, sourceWeight: {}, bannedKeywords: [] }
  document.querySelectorAll('#prefsView input[data-wt]').forEach((inp) => {
    const n = parseFloat(inp.value)
    if (!isNaN(n) && inp.dataset.k) w[inp.dataset.wt][inp.dataset.k] = n
  })
  document.querySelectorAll('#prefsView [data-ban-live]').forEach((el) => w.bannedKeywords.push(el.dataset.banLive))
  return w
}
$('#prefsView').addEventListener('click', async (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  const w = harvestWeights()
  if (btn.dataset.wtDel) { delete w[btn.dataset.wtDel][btn.dataset.k]; state.prefs = { ...state.prefs, ...w }; renderPrefs(); saveWeightsPost(w); return }
  if (btn.dataset.wtAdd) {
    const name = btn.parentElement.querySelector('input').value.trim()
    if (!name) return
    w[btn.dataset.wtAdd][name] = 1.0; state.prefs = { ...state.prefs, ...w }; renderPrefs(); saveWeightsPost(w); return
  }
  if (btn.dataset.banDel) { w.bannedKeywords = w.bannedKeywords.filter((k) => k !== btn.dataset.banDel); state.prefs = { ...state.prefs, ...w }; renderPrefs(); return }
  if (btn.id === 'banAdd') {
    const v = $('#banNew').value.trim()
    if (v && !w.bannedKeywords.includes(v)) w.bannedKeywords.push(v)
    state.prefs = { ...state.prefs, ...w }; renderPrefs(); saveWeightsPost(w); return
  }
  if (btn.dataset.banDel) {
    w.bannedKeywords = w.bannedKeywords.filter((k) => k !== btn.dataset.banDel)
    state.prefs = { ...state.prefs, ...w }; renderPrefs(); saveWeightsPost(w); return
  }
})
// 权重自动落盘:字段改/行增删都走这
async function saveWeightsPost(w) {
  try { const r = await post('/prefs', w || harvestWeights()); state.prefs = r.prefs || state.prefs; toast('权重已保存') }
  catch (err) { toast(`保存失败: ${err.message}`) }
}
$('#prefsView').addEventListener('change', (e) => { if (e.target.matches('input[data-wt]')) debounce(saveWeightsPost)() })

$('#btnTune').addEventListener('click', async () => {
  const text = $('#tuneText').value.trim()
  if (!text) return
  try {
    const r = await post('/tune', { text })
    $('#tuneResult').innerHTML = r.ok
      ? `<p class="ok">已应用: ${esc((r.actions || []).join('；'))}</p>`
      : `<p class="err">${esc(r.error || '无法解析')}</p>`
    loadPrefs()
  } catch (e) { $('#tuneResult').innerHTML = `<p class="err">${esc(e.message)}</p>` }
})

// ---- 可搜索下拉：原生 <select> 留作数据源（加载/保存逻辑不动），换成带关键词过滤的弹层 ----
// select 的 innerHTML 重建 / disabled 切换经 MutationObserver 同步；选中回写 value + 派发 change 走原保存链路
function makeSearchableSelect(id) {
  const sel = document.getElementById(id)
  if (!sel) return
  sel.classList.add('fsel-src')
  const wrap = document.createElement('div')
  wrap.className = 'fsel'
  wrap.innerHTML = '<button type="button" class="fsel-btn" aria-haspopup="listbox"><span class="fsel-txt"></span><span class="fsel-car">▾</span></button><div class="fsel-pop" hidden><input class="fsel-q" type="text" placeholder="输入关键词过滤"><div class="fsel-list" role="listbox"></div></div>'
  sel.after(wrap)
  const btn = wrap.querySelector('.fsel-btn'), txt = wrap.querySelector('.fsel-txt')
  const pop = wrap.querySelector('.fsel-pop'), q = wrap.querySelector('.fsel-q'), list = wrap.querySelector('.fsel-list')
  const close = () => { pop.hidden = true }
  const syncBtn = () => {
    const o = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null
    txt.textContent = o ? o.textContent : '加载中…'
    txt.classList.toggle('fsel-empty', !o || !o.value)
    btn.disabled = sel.disabled
  }
  const renderList = () => {
    const k = q.value.trim().toLowerCase()
    const opts = [...sel.options].filter((o) => !k || o.textContent.toLowerCase().includes(k))
    list.innerHTML = opts.length
      ? opts.map((o) => `<div class="fsel-opt${o.value === sel.value ? ' cur' : ''}" role="option" data-v="${esc(o.value)}">${esc(o.textContent)}</div>`).join('')
      : '<div class="fsel-none">无匹配项</div>'
  }
  const open = () => {
    if (sel.disabled) return
    q.value = ''; pop.hidden = false; renderList()
    const r = btn.getBoundingClientRect()
    pop.style.minWidth = `${Math.max(r.width, 230)}px`
    const ph = pop.offsetHeight, pw = pop.offsetWidth, below = innerHeight - r.bottom
    pop.style.top = `${below >= ph + 8 || below >= r.top ? r.bottom + 4 : Math.max(4, r.top - ph - 4)}px`
    pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - pw - 8))}px`
    list.querySelector('.fsel-opt.cur')?.scrollIntoView({ block: 'nearest' })
    q.focus()
  }
  // 组件嵌在 <label for=select> 内——preventDefault 取消 label 的激活转发，避免点到隐藏 select
  btn.addEventListener('click', (e) => { e.preventDefault(); pop.hidden ? open() : close() })
  q.addEventListener('input', renderList)
  list.addEventListener('click', (e) => {
    const opt = e.target.closest('.fsel-opt'); if (!opt) return
    e.preventDefault()
    sel.value = opt.dataset.v
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    close()
  })
  pop.addEventListener('keydown', (e) => {
    const opts = [...list.querySelectorAll('.fsel-opt')]
    if (e.key === 'Escape') { close(); btn.focus(); return }
    if (!opts.length) return
    const idx = opts.findIndex((o) => o.classList.contains('hov'))
    if (e.key === 'Enter') { e.preventDefault(); (opts[idx] || list.querySelector('.fsel-opt.cur') || opts[0]).click() }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = e.key === 'ArrowDown' ? Math.min(opts.length - 1, idx + 1) : Math.max(0, idx < 0 ? opts.length - 1 : idx - 1)
      opts.forEach((o, i) => o.classList.toggle('hov', i === next))
      opts[next].scrollIntoView({ block: 'nearest' })
    }
  })
  list.addEventListener('mousemove', () => list.querySelector('.fsel-opt.hov')?.classList.remove('hov'))
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close() })
  window.addEventListener('scroll', close, true) // fixed 弹层不跟滚动，页面一动就收
  window.addEventListener('resize', close)
  sel.addEventListener('change', syncBtn)
  new MutationObserver(() => { syncBtn(); if (!pop.hidden) renderList() })
    .observe(sel, { childList: true, attributes: true, attributeFilter: ['disabled'] })
  syncBtn()
}
makeSearchableSelect('llmModel')
makeSearchableSelect('tlModel')

// ---- 日报模型选择 ----

async function loadLlm() {
  try {
    const r = await api('/llm')
    const eff = { ui: '界面指定', config: '配置指定', auto: '自动路由' }[r.effective] || r.effective
    $('#llmInfo').textContent = r.available
      ? `当前生效: ${r.current.provider || '自动'}/${r.current.model || '自动'}（来源: ${eff}）`
      : '宿主无 LLM 服务——摘要走抽取式降级'
    if (!r.available) return
    $('#llmProvider').innerHTML = r.providers.map((p) =>
      `<option value="${esc(p.id)}" ${p.id === r.current.provider ? 'selected' : ''}>${esc(p.id)}</option>`).join('')
    const llmProv = r.current.provider || r.providers[0]?.id || ''
    const llmModels = await loadLlmModels(llmProv, r.current.model)
    if (llmModels && r.current.model && !llmModels.includes(r.current.model)) {
      $('#llmInfo').textContent += '（该模型不在 provider 列表中，请重新选择）'
    }
    // 翻译模型：独立覆盖，缺省跟随日报模型
    const t = state.prefs?.translateLlm
    $('#tlProvider').innerHTML = r.providers.map((p) =>
      `<option value="${esc(p.id)}" ${p.id === (t?.provider || r.current.provider) ? 'selected' : ''}>${esc(p.id)}</option>`).join('')
    const tlProv = t?.provider || r.current.provider || r.providers[0]?.id || ''
    const tlModels = await loadTlModels(tlProv, t?.model || '')
    $('#tlInfo').textContent = t?.provider && t?.model
      ? `翻译模型: ${t.provider}/${t.model}` + (tlModels && !tlModels.includes(t.model) ? '（该模型不在 provider 列表中，请重新选择）' : '')
      : '翻译模型: 跟随日报模型'
    $('#navEntry').checked = state.prefs?.showNavEntry !== false
    $('#notifyDesktop').checked = state.prefs?.notifyDesktop === true
    loadLoopGuard()
    loadBackup()
    $('#autoTranslate').checked = !!state.prefs?.autoTranslate
    $('#autoTlWarn').hidden = !$('#autoTranslate').checked
  } catch (e) { $('#llmInfo').textContent = `模型信息不可用: ${esc(e.message)}` }
}

let tlModelSeq = 0 // 模型列表请求序号：仅最新一轮允许写 DOM/触发保存
async function loadTlModels(provider, selected) {
  const sel = $('#tlModel')
  if (!provider) return null // 空 provider 不算新请求——不能作废在飞的一轮（否则 sel 永远禁用）
  const seq = ++tlModelSeq
  sel.disabled = true // 加载期间禁用：防止从旧 provider 列表里选出错配模型
  try {
    const r = await api(`/llm?provider=${encodeURIComponent(provider)}`)
    if (seq !== tlModelSeq) return null // 已有更新一轮请求：本次结果作废
    sel.innerHTML = r.models.map((m) =>
      `<option value="${esc(m)}" ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('')
    return r.models
  } catch { return null } // 拉取失败不触发保存，避免 provider/model 错配落盘
  finally { if (seq === tlModelSeq) sel.disabled = false }
}

// LLM 设置区串行队列：「加载模型→保存→loadLlm 重渲」必须排队——并发 loadLlm 会互相重建下拉，
// 把用户刚选的 provider 冲掉（表现为选了又弹回、保存不到）
let llmChain = Promise.resolve()
const enqueueLlm = (fn) => {
  llmChain = llmChain.then(fn).catch((e) => console.warn('llm settings queue:', e))
  return llmChain
}

const saveTlModel = async (provider) => {
  try {
    const r = await post('/llm', { provider: provider ?? $('#tlProvider').value, model: $('#tlModel').value, scope: 'translate' })
    if (state.prefs) state.prefs.translateLlm = r.translateLlm // 同步本地缓存：loadLlm 用它重渲下拉，避免被旧值刷回
    toast('翻译模型已保存'); loadLlm()
  } catch (e) { toast(`保存失败: ${e.message}`) }
}
// 换 provider 必须先等模型列表就位再保存——否则读到的是旧 provider 的模型名，存成错配对；
// provider 显式传参：等待期间下拉可能被 loadLlm 重建，不能回读 DOM
$('#tlProvider').addEventListener('change', (e) => {
  const provider = e.target.value
  enqueueLlm(async () => {
    const prev = $('#tlModel').value // 旧已选模型：新列表里有就保留，没有回落首项
    const ms = await loadTlModels(provider, prev)
    if (ms !== null) await saveTlModel(provider)
  })
})
$('#tlModel').addEventListener('change', () => enqueueLlm(() => saveTlModel()))

let llmModelSeq = 0 // 同上：仅最新一轮允许写 DOM/触发保存
async function loadLlmModels(provider, selected) {
  const sel = $('#llmModel')
  if (!provider) return null // 同上：空 provider 不作废在飞请求
  const seq = ++llmModelSeq
  sel.disabled = true // 加载期间禁用：防止从旧 provider 列表里选出错配模型
  try {
    const r = await api(`/llm?provider=${encodeURIComponent(provider)}`)
    if (seq !== llmModelSeq) return null // 已有更新一轮请求：本次结果作废
    sel.innerHTML = r.models.map((m) =>
      `<option value="${esc(m)}" ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('')
    return r.models
  } catch { return null } // 拉取失败不触发保存，避免 provider/model 错配落盘
  finally { if (seq === llmModelSeq) sel.disabled = false }
}

const saveLlmModel = async (provider) => {
  const prov = provider ?? $('#llmProvider').value
  const model = $('#llmModel').value
  if (!prov || !model) return toast('provider 和 model 都要选')
  await post('/llm', { provider: prov, model })
  toast('模型已保存，下次日报生效')
  loadLlm()
}
// 换 provider 必须先等模型列表就位再保存——否则读到的是旧 provider 的模型名，存成错配对；provider 显式传参防 DOM 被重建后读回旧值
$('#llmProvider').addEventListener('change', (e) => {
  const provider = e.target.value
  enqueueLlm(async () => {
    const prev = $('#llmModel').value // 旧已选模型：新列表里有就保留，没有回落首项
    const ms = await loadLlmModels(provider, prev)
    if (ms !== null) await saveLlmModel(provider)
  })
})
$('#llmModel').addEventListener('change', () => enqueueLlm(() => saveLlmModel()))
$('#btnLlmClear').addEventListener('click', () => enqueueLlm(async () => {
  await post('/llm', { provider: '', model: '' })
  toast('已恢复自动路由')
  loadLlm()
}))

// ---- 定时调度 ----

// 每个时刻一行；首行 ＋ 新增空行，后续行 − 删除本行
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/
function timeRow(value, isFirst) {
  const row = document.createElement('div'); row.className = 'sched-row'
  const inp = document.createElement('input'); inp.type = 'time'; inp.value = value || ''
  inp.addEventListener('change', () => saveSchedule()) // 时刻修改即生效
  const add = document.createElement('button')
  add.textContent = '＋'; add.title = '新增时刻'
  add.onclick = () => { row.parentElement.appendChild(timeRow('', false)); saveSchedule() }
  row.append(inp, add)
  if (!isFirst) { // 第二行起同时有 ＋ 和 −
    const del = document.createElement('button')
    del.textContent = '−'; del.title = '删除该时刻'
    del.onclick = () => { row.remove(); saveSchedule() }
    row.append(del)
  }
  return row
}
function fillTimeRows(sel, values) {
  const c = $(sel); c.innerHTML = ''
  const vs = (values || []).length ? values : ['']
  vs.forEach((v, i) => c.appendChild(timeRow(v, i === 0)))
}
const collectTimes = (sel) => [...$(sel).querySelectorAll('input')].map((i) => i.value.trim()).filter((v) => TIME_RE.test(v))

async function loadSchedule() {
  try {
    const r = await api('/schedule')
    fillTimeRows('#schedDigestRows', r.schedule.digestTimes || [])
    fillTimeRows('#schedFetchRows', r.schedule.fetchTimes || [])
    $('#schedInterval').value = r.schedule.intervalMinutes ?? ''
    $('#schedStartup').checked = !!r.schedule.onStartup
    $('#schedInfo').textContent = `生效来源: ${r.effective === 'ui' ? '界面指定' : '配置默认'}；同一时刻若两表都含，先抓取后生成日报`
  } catch (e) { $('#schedInfo').textContent = `调度信息不可用: ${esc(e.message)}` }
}

async function saveSchedule() { // function 声明提升:timeRow 先引用后定义
  const digestTimes = collectTimes('#schedDigestRows')
  const fetchTimes = collectTimes('#schedFetchRows')
  const iv = $('#schedInterval').value.trim()
  try {
    await post('/schedule', { digestTimes, fetchTimes, intervalMinutes: iv === '' ? undefined : Number(iv), onStartup: $('#schedStartup').checked })
    toast('调度已保存')
  } catch { /* 行内空值时静默 */ }
}
$('#schedInterval').addEventListener('input', debounce(saveSchedule))
$('#schedStartup').addEventListener('change', saveSchedule)
$('#btnSchedClear').addEventListener('click', async () => {
  await post('/schedule', { clear: true })
  toast('已恢复配置默认')
  loadSchedule()
})

// ---- 危险区：二次确认删除（共用武装模式） ----
// armOnce 提升为模块级：专题行的再生成/删除也走同一二次确认
const armOnce = (b, label, armText) => { // 返回 true=已确认可执行
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1'; b.textContent = armText; b.classList.add('armed')
    setTimeout(() => { b.dataset.armed = ''; b.textContent = label; b.classList.remove('armed') }, 5000)
    return false
  }
  b.dataset.armed = ''; b.classList.remove('armed'); return true
}
$('#btnClearAll')?.addEventListener('click', async (e) => {
  const b = e.target
  if (!armOnce(b, '删除所有新闻', '⚠ 确认删除全部新闻？再点一次执行')) return
  b.disabled = true; b.textContent = '删除中…'
  try {
    const r = await post('/items/clear', {})
    toast(`已删除 ${r.deleted} 条新闻`); state.page = 1; state.sort = 'published'; localStorage.removeItem(POS_KEY); loadItems(); loadStatus()
  } catch (err) { toast(`删除失败: ${err.message}`) }
  b.disabled = false; b.textContent = '删除所有新闻'
})
$('#btnClearDigests')?.addEventListener('click', async (e) => {
  const b = e.target
  if (!armOnce(b, '清除日报/快报', '⚠ 确认删除全部日报与快报？再点一次执行')) return
  b.disabled = true; b.textContent = '删除中…'
  try {
    const r = await post('/digests/clear', {})
    toast(`已删除 ${r.deleted} 个日报/快报文件`)
    if (!$('#tab-digest')?.hidden) loadDigest()
  } catch (err) { toast(`删除失败: ${err.message}`) }
  b.disabled = false; b.textContent = '清除日报/快报'
})

// ---- 弹层：新人引导 + 升级提示（共用分步组件） ----
function showSteps({ title, steps, doneText = '完成', onDone }) {
  let idx = 0
  const ov = document.createElement('div'); ov.className = 'obOverlay'
  const render = () => {
    const st = steps[idx]
    ov.innerHTML = `<div class="obCard">
      <h3>${esc(title)}</h3>
      <h4>${esc(st.title)}</h4>
      <div class="obBody">${st.bodyHtml || esc(st.body)}</div>
      <div class="obNav">
        <span class="obDots">${steps.map((_, i) => `<i${i === idx ? ' class="on"' : ''}></i>`).join('')}</span>
        <span>
          ${idx > 0 ? '<button data-ob="prev" class="ghost">上一步</button>' : ''}
          <button data-ob="next" class="primary">${idx === steps.length - 1 ? esc(doneText) : '下一步'}</button>
        </span>
      </div>
      <button class="obSkip" data-ob="skip" title="跳过">✕</button>
    </div>`
  }
  ov.addEventListener('click', (e) => {
    const act = e.target.closest('[data-ob]')?.dataset.ob
    if (act === 'prev' && idx > 0) { idx--; render() }
    else if (act === 'next') { if (idx < steps.length - 1) { idx++; render() } else close() }
    else if (act === 'skip') close()
  })
  const close = () => { ov.remove(); onDone?.() }
  render(); document.body.appendChild(ov)
}
const LS_SEEN_VER = 'rss_seen_version'
const maybeShowOnboardAndUpgrade = (version) => {
  if (!localStorage.getItem(ONBOARD_KEY)) { // 首启:先引导,完事顺手记版本不弹升级
    showSteps({
      title: '欢迎使用 RSS 每日精选',
      steps: ONBOARD_STEPS,
      doneText: '开始用',
      onDone: () => { localStorage.setItem(ONBOARD_KEY, '1'); if (version) localStorage.setItem(LS_SEEN_VER, version) },
    })
    return
  }
  if (version && localStorage.getItem(LS_SEEN_VER) !== version) { // 升级:第1页致谢+第2页更新
    const entry = (typeof CHANGELOG !== 'undefined' ? CHANGELOG : []).find((c) => c.v === version) || CHANGELOG[0]
    if (entry) showSteps({
      title: `已更新到 v${version}`,
      steps: [
        { title: '本次更新', bodyHtml: `<ul>${entry.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` },
      ],
      doneText: '知道了',
      onDone: () => localStorage.setItem(LS_SEEN_VER, version),
    })
    else localStorage.setItem(LS_SEEN_VER, version)
  }
}
api('/status').then((s) => maybeShowOnboardAndUpgrade(s.version)).catch(() => {})
// 设置区手工触发
$('#btnShowUpgrade')?.addEventListener('click', () => {
  const entry = (typeof CHANGELOG !== 'undefined' ? CHANGELOG[0] : null)
  if (entry) showSteps({
    title: `v${entry.v} 更新内容`,
    steps: [
      { title: '本次更新', bodyHtml: `<ul>${entry.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` },
    ],
    doneText: '关闭',
  })
})
$('#btnShowOnboard')?.addEventListener('click', () => {
  showSteps({ title: '功能引导', steps: ONBOARD_STEPS, doneText: '完成' })
})

// ---- token 统计（彩蛋：版本号点 10 次解锁） ----
let statsData = null
const fmtTok = (n) => { // ≥1e6 进位 M；小数去尾零（3.0M→3M，21.9M 保一位）
  const u = n >= 1e6 ? [n / 1e6, 'M'] : n >= 1000 ? [n / 1000, 'k'] : null
  return u ? `${parseFloat(u[0].toFixed(1))}${u[1]}` : `${n}`
}
const STAT_FEATURES = [['digest', '日报'], ['score', '评分/快报'], ['translate', '翻译'], ['topic', '专题']]
// 单价（每百万 tokens）：处理模型覆盖日报/评分/专题，翻译模型覆盖翻译桶
const priceOfFeature = (f) => { const p = state.prefs?.tokenPrice || {}; return f === 'translate' ? p.translate : p.digest }
const costOf = (io, f) => { const p = priceOfFeature(f); return p && io ? (io.in * (p.in || 0) + (io.cached || 0) * (p.cached ?? p.in ?? 0) + io.out * (p.out || 0)) / 1e6 : 0 }
const fmtCost = (x) => x.toFixed(x >= 100 ? 0 : 2)
const hasPrice = () => !!(state.prefs?.tokenPrice?.digest || state.prefs?.tokenPrice?.translate)
function renderPriceInputs() {
  const p = state.prefs?.tokenPrice || {}
  const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v ?? '' }
  set('#priceDigestIn', p.digest?.in); set('#priceDigestOut', p.digest?.out); set('#priceDigestCached', p.digest?.cached)
  set('#priceTrIn', p.translate?.in); set('#priceTrOut', p.translate?.out); set('#priceTrCached', p.translate?.cached)
}
function renderStats() {
  const body = $('#statsBody'); if (!body || !statsData) return
  const view = $('#statsView').value, range = +$('#statsRange').value
  const days = Object.entries(statsData.days || {}).sort((a, b) => b[0].localeCompare(a[0]))
  const filtered = range ? days.slice(0, range) : days
  const rangeTxt = $('#statsRange')?.selectedOptions?.[0]?.textContent || ''
  if (view === 'day') {
    const sum = { in: 0, out: 0, cached: 0, cost: 0 }
    const fsum = Object.fromEntries(STAT_FEATURES.map(([f]) => [f, { in: 0, out: 0, cached: 0, legacy: 0 }]))
    const rowCost = (v) => STAT_FEATURES.reduce((s, [f]) => s + costOf(v.featureIO?.[f], f), 0)
    for (const [, v] of filtered) {
      sum.in += v.in; sum.out += v.out; sum.cached += v.cached ?? 0; sum.cost += rowCost(v)
      for (const [f] of STAT_FEATURES) {
        const io = v.featureIO?.[f]
        if (io) { fsum[f].in += io.in; fsum[f].out += io.out; fsum[f].cached += io.cached ?? 0 } else fsum[f].legacy += v[f] ?? 0
      }
    }
    const showCost = hasPrice() // 未设单价：费用不渲染（每日/区间汇总都属于支出汇总）
    const fchip = (f, o, legacy = 0) => { // 功能 chip：io 有量→「入/出·缓N」；仅有旧合计→「N旧」；全空→—
      const name = STAT_FEATURES.find(([x]) => x === f)?.[1]
      const ioTxt = (o.in || o.out || o.cached) ? `${fmtTok(o.in)}/${fmtTok(o.out)}${o.cached ? `·缓${fmtTok(o.cached)}` : ''}` : ''
      const legTxt = legacy ? `${ioTxt ? '+' : ''}${fmtTok(legacy)}<small class="stats-legacy">旧</small>` : ''
      return `${name} ${ioTxt}${legTxt ? (ioTxt ? ' ' : '') + legTxt : ''}${ioTxt || legTxt ? '' : '—'}`
    }
    body.innerHTML = filtered.length
      ? `<div class="st-sum"><div class="st-sum-l1"><strong>汇总${rangeTxt ? `（${rangeTxt}）` : ''}</strong><span class="st-io">${fmtTok(sum.in)} / ${fmtTok(sum.out)}${sum.cached ? ` ·缓${fmtTok(sum.cached)}` : ''}</span>${showCost ? `<span class="st-cost">${fmtCost(sum.cost)}</span>` : ''}</div>`
        + `<div class="st-chips">${STAT_FEATURES.map(([f]) => `<span class="st-f">${fchip(f, fsum[f], fsum[f].legacy)}</span>`).join('')}</div></div>`
        + filtered.map(([d, v]) => `<div class="st-row"><div class="st-r1"><span class="st-date">${d}</span><span class="st-io">${fmtTok(v.in)} / ${fmtTok(v.out)}${v.cached ? ` ·缓${fmtTok(v.cached)}` : ''}</span>${showCost ? `<span class="st-cost">${fmtCost(rowCost(v))}</span>` : ''}</div>`
          + `<div class="st-r2">${STAT_FEATURES.map(([f]) => `<span class="st-f">${fchip(f, v.featureIO?.[f] ?? { in: 0, out: 0, cached: 0 }, v.featureIO?.[f] ? 0 : (v[f] ?? 0))}</span>`).join('')}</div></div>`).join('')
        + (fsum.digest.legacy || fsum.score.legacy || fsum.translate.legacy || fsum.topic.legacy ? '<p class="stats-note">带「旧」后缀=早期数据未拆输入/输出，仅合计值，不计入费用；「缓」= 命中缓存的输入 token，不计入「输入」列</p>' : '<p class="stats-note">「缓」= 命中缓存的输入 token，不计入「输入」列</p>')
      : '<p class="empty">暂无数据</p>'
  } else if (view === 'feature') {
    body.innerHTML = STAT_FEATURES.map(([f, k]) => {
      let fin = 0, fout = 0, fcache = 0, legacy = 0
      for (const [, v] of filtered) {
        const io = v.featureIO?.[f]
        if (io) { fin += io.in; fout += io.out; fcache += io.cached ?? 0 } else legacy += v[f] ?? 0
      }
      const fc = priceOfFeature(f) ? ` · 费用 ${fmtCost(costOf({ in: fin, out: fout, cached: fcache }, f))}` : '' // 该功能有单价才显示费用
      return `<div class="hist-item"><span>${k}</span><span>入 ${fmtTok(fin)} · 出 ${fmtTok(fout)}${fcache ? ` · 缓存 ${fmtTok(fcache)}` : ''}${legacy ? ` · 旧合计 ${fmtTok(legacy)}` : ''} tok${fc}</span></div>`
    }).join('')
  } else {
    body.innerHTML = `<div class="hist-item"><span>总输入</span><span>${fmtTok(statsData.totalIn)} tok</span></div>`
      + `<div class="hist-item"><span>总输出</span><span>${fmtTok(statsData.totalOut)} tok</span></div>`
      + (statsData.totalCached ? `<div class="hist-item"><span>总缓存命中</span><span>${fmtTok(statsData.totalCached)} tok</span></div>` : '')
      + `<div class="hist-item"><span>合计</span><span>${fmtTok(statsData.totalIn + statsData.totalOut)} tok</span></div>`
      + (hasPrice() ? `<div class="hist-item"><span>区间费用${rangeTxt ? `（${rangeTxt}）` : ''}</span><span>${fmtCost(filtered.reduce((s, [, v]) => s + STAT_FEATURES.reduce((ss, [f]) => ss + costOf(v.featureIO?.[f], f), 0), 0))}</span></div>` : '')
  }
}
$('#statsView')?.addEventListener('change', renderStats)
$('#statsRange')?.addEventListener('change', renderStats)
// 单价：input 实时按输入值重算费用列（不保存），change 才整组落盘（留空视为未设；缓价留空=按入价计，显式填 0 = 缓存免费）
const readPrice = (id) => { const s = $(id).value.trim(); if (!s) return undefined; const n = parseFloat(s); return Number.isFinite(n) && n >= 0 ? n : undefined }
const priceTriple = (i, o, c) => (i !== undefined || o !== undefined || c !== undefined ? { in: i ?? 0, out: o ?? 0, ...(c !== undefined ? { cached: c } : {}) } : undefined)
const collectPrices = () => ({ digest: priceTriple(readPrice('#priceDigestIn'), readPrice('#priceDigestOut'), readPrice('#priceDigestCached')), translate: priceTriple(readPrice('#priceTrIn'), readPrice('#priceTrOut'), readPrice('#priceTrCached')) })
for (const id of ['#priceDigestIn', '#priceDigestOut', '#priceDigestCached', '#priceTrIn', '#priceTrOut', '#priceTrCached']) {
  $(id)?.addEventListener('input', () => { // 实时预览：输入即把值写进内存重算每日/区间费用，列随设价即时出现
    state.prefs = { ...(state.prefs || {}), tokenPrice: collectPrices() }
    renderStats()
  })
  $(id)?.addEventListener('change', async () => {
    try {
      const r = await post('/prefs', { tokenPrice: collectPrices() })
      state.prefs = r.prefs || state.prefs
      renderPriceInputs(); renderStats()
      toast('单价已保存')
    } catch (e) { toast(`保存失败: ${e.message}`) }
  })
}
let verClicks = 0, verTimer = 0
$('#versionTag')?.addEventListener('click', () => {
  clearTimeout(verTimer); verTimer = setTimeout(() => { verClicks = 0 }, 1500)
  if (++verClicks >= 10) {
    verClicks = 0
    const dev = $('#devSection')
    if (dev) {
      dev.hidden = false
      dev.closest('details.settings-fold')?.setAttribute('open', '') // 高级与排障默认收起：只摘 hidden 仍看不见，连带展开
      dev.scrollIntoView({ block: 'nearest' })
    }
    loadDevlog()
    toast('已解锁开发者选项')
  }
})

// ---- 开发日志（彩蛋区内）：完整模型对话 + token/速度，JSONL 按天落 devlog/ ----
async function loadDevlog() {
  try {
    const r = await api('/devlog')
    if ($('#devLogEnabled')) $('#devLogEnabled').checked = !!r.enabled
    const info = $('#devlogInfo')
    if (info) {
      const f = r.files?.[0]
      info.textContent = f ? `最新 ${f.name} · ${(f.size / 1024).toFixed(0)}KB` : (r.dir ? '暂无日志文件' : '')
    }
  } catch { /* ignore */ }
}
$('#devLogEnabled')?.addEventListener('change', async (e) => {
  try {
    await post('/prefs', { devLog: e.target.checked })
    toast(e.target.checked ? '开发日志已开启——完整模型对话将写入 devlog/' : '开发日志已关闭')
    loadDevlog()
  } catch (err) { toast(`保存失败: ${err.message}`); e.target.checked = !e.target.checked }
})
$('#btnOpenDevlog')?.addEventListener('click', async () => {
  try {
    const r = await post('/devlog/open', {})
    toast(r.ok ? '已打开日志文件夹' : `打开失败: ${r.error || '未知错误'}`)
  } catch (e) { toast(`打开失败: ${e.message}`) }
})
api('/status').then((s) => { if (s.version) $('#versionTag').textContent = `v${s.version}`; if (s.tokenStats) { statsData = s.tokenStats; renderStats() } }).catch(() => {})

// 彩蛋区：强行显示档案按钮——sessionStorage 会话级，重启即失效
if ($('#forceArchive')) $('#forceArchive').checked = state.forceArchive
$('#forceArchive')?.addEventListener('change', (e) => {
  state.forceArchive = e.target.checked
  sessionStorage.setItem('rnd-force-archive', e.target.checked ? '1' : '0')
  updateArchiveBtn()
  toast(e.target.checked ? '已强行显示档案按钮（重启后恢复默认）' : '已恢复默认显隐')
})

// ---- 初始化 ----

// 选项卡滑动墨水丸：瞬时到位+形变回弹（taste-skill motion：transform 240ms，不动画布局属性）
const tabInd = $('.tab-ind')
function moveTabInd(tab, animate = true) {
  if (!tabInd || !tab) return
  const prev = { l: tabInd.offsetLeft, w: tabInd.offsetWidth }
  tabInd.style.left = `${tab.offsetLeft}px`
  tabInd.style.width = `${tab.offsetWidth}px`
  if (animate && prev.w > 0) {
    tabInd.style.transformOrigin = tab.offsetLeft > prev.l ? 'left center' : 'right center'
    tabInd.style.transform = `scaleX(${prev.w / tab.offsetWidth})`
    requestAnimationFrame(() => { tabInd.style.transform = 'scaleX(1)' })
  }
}
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('active', b === btn)
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false')
    })
    moveTabInd(btn)
    for (const sec of document.querySelectorAll('main > section')) sec.hidden = true
    $(`#tab-${btn.dataset.tab}`).hidden = false
    state.tab = btn.dataset.tab
    applyWide() // 宽屏偏好按页生效——items/digest 各自独立
    $('#statusbar').hidden = btn.dataset.tab === 'digest'
    if (btn.dataset.tab === 'digest') {
      const today = dayStr(new Date())
      const sel = $('#digestDay').value
      // 输入框非今天→复位今天；除非框里就是用户今天亲手选的日期（回退写入的昨天不算主动选择）
      if (sel && sel !== today && !(state.daySetOn === today && sel === state.dayPicked)) $('#digestDay').value = today
      loadDigest()
    }
    if (btn.dataset.tab === 'sources') loadSources()
    if (btn.dataset.tab === 'prefs') { loadPrefs(); enqueueLlm(loadLlm); loadSchedule(); renderStats() }
  })
})

$('#btnResetPrefs').addEventListener('click', async () => {
  if (!confirm('重置全部偏好权重与调教历史？')) return
  await post('/tune', { text: '重置' })
  loadPrefs()
})

const pendingPos = restorePos()
if (pendingPos) state.page = pendingPos.page
// 页内查找条：Electron webview 无原生 Ctrl+F，自研——window.find() 高亮+跳转
const findbar = $('#findbar'), findInput = $('#findInput')
const doFind = (back) => { const q = findInput.value; if (q) window.find(q, false, back, true, false, true) }
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault()
    findbar.hidden = false; findInput.focus(); findInput.select()
  }
})
findInput.addEventListener('input', () => { window.getSelection()?.removeAllRanges(); doFind(false) })
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doFind(e.shiftKey) }
  if (e.key === 'Escape') { findbar.hidden = true; window.getSelection()?.removeAllRanges() }
})
$('#findNext').addEventListener('click', () => doFind(false))
$('#findPrev').addEventListener('click', () => doFind(true))
$('#findClose').addEventListener('click', () => { findbar.hidden = true; window.getSelection()?.removeAllRanges() })

state.sort = 'published'; $('#sortSel').value = 'published' // 每次进入默认按发布时间（抓取后切过的 fetched 不残留）
$('#digestView').dataset.kind = state.digestKind // ?kind=hourly 直达时首帧就选对字号变量
loadPrefs() // 预载 prefs：字号缩放进首页就生效（设置页输入也顺手填好）
moveTabInd($('.tab.active'), false)
window.addEventListener('resize', () => moveTabInd($('.tab.active'), false))
if (state.digestKind !== 'digest') { syncKindUI(); $('.tab[data-tab="digest"]')?.click() } // ?kind=hourly/topics 直达对应页
// 首屏三个请求并行：sources 只为填源过滤器，items 不等它——早一个 RTT 出新闻
loadStatus(); loadSources(); loadItems().then(() => { if (pendingPos?.id) scrollToAnchor(pendingPos) })
setInterval(loadStatus, 2000) // 未读计数 2s 轮询
