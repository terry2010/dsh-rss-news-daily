/* dsh-rss-news-daily 阅读器（零构建，原生 JS）。全部数据走 /dsh-rss-news-daily/api/* */
const API = '/dsh-rss-news-daily/api'

// 主题跟随宿主：?theme= 管首屏不闪，postMessage 管之后明暗切换不重载
const applyTheme = (t) => { if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t }
applyTheme(new URLSearchParams(location.search).get('theme'))
window.addEventListener('message', (e) => { if (e.data && e.data.type === 'rnd-theme') applyTheme(e.data.theme) })
// 宿主跳转指令（通知点击→client.js postMessage）：切到今日精选页并按指定 kind 展示
window.addEventListener('message', (e) => {
  const d = e && e.data
  if (!d || d.type !== 'rnd-view') return
  state.digestKind = d.kind === 'hourly' ? 'hourly' : 'digest'
  document.querySelector('.tab[data-tab="digest"]')?.click()
})

const state = { page: 1, items: [], sources: [], prefs: null, digestDay: '', digestKind: new URLSearchParams(location.search).get('kind') === 'hourly' ? 'hourly' : 'digest', generating: false, sort: 'published', total: 0, pageSize: 50, daySetOn: '', dayPicked: '', archiveYears: [], forceArchive: sessionStorage.getItem('rnd-force-archive') === '1' }
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

async function loadStatus() {
  try {
    const s = await api('/status')
    $('#statusbar').textContent = `${s.enabled}/${s.sources} 源 · 今日+${s.todayAdded ?? 0} · 本次+${s.lastAdded ?? 0} · 共${s.items} 条 · ${s.failures?.length ? `${s.failures.length} 源异常${s.cooling ? `（${s.cooling} 冷却中）` : ''}` : '健康'}`
  } catch { $('#statusbar').textContent = '状态不可用' }
}

// ---- 阅读字号缩放：scope=items(全部新闻)/digest(日报)/hourly(快报)；存 prefs.fontSize 重启后仍生效 ----
// 分项值(items/digest/hourly)优先于设置页统一值(global)；设置页调整=整体覆盖 fontSize，分项被清除
const FZ = { MIN: 0.8, MAX: 1.6, STEP: 0.1 }
// feed description 常见"查看原文"类引导文案——后端入库已剥，这里再兜底存量数据
const LEAD_STUB = /(?:…|\.{2,})?\s*(?:点击\s*(?:查看|阅读|标题)?\s*(?:查看|阅读)?原文|阅读原文|阅读全文|点击阅读全文|点击查看全文|查看全文|点击阅读|阅读详细|阅读更多|查看更多|查看详情|详情请点击|点此查看全文|read(?:\s+the)?\s+full\s+(?:article|story|post|content)|continue\s+reading|read\s+more|view\s+original)\s*(?:[>》»→›↗]|\.{1,3})*/gi
const FZ_LABEL = { items: '全部新闻', digest: '日报', hourly: '快报' }
const fzEff = (scope) => { const f = state.prefs?.fontSize || {}; return f[scope] ?? f.global ?? 1 }
const fzPct = (v) => `${Math.round(v * 100)}%`
function applyFontSize() {
  const st = document.documentElement.style
  for (const s of ['items', 'digest', 'hourly']) st.setProperty(`--fz-${s}`, String(fzEff(s)))
  const f = state.prefs?.fontSize || {}
  if ($('#fzVal')) $('#fzVal').textContent = f.global != null ? fzPct(f.global) : (f.items != null || f.digest != null || f.hourly != null ? '分项' : '100%')
  if ($('#fzScopes')) $('#fzScopes').textContent = `全部新闻 ${fzPct(fzEff('items'))} · 日报 ${fzPct(fzEff('digest'))} · 快报 ${fzPct(fzEff('hourly'))}`
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
    state.items = r.items; state.total = r.total; state.pageSize = r.pageSize
    renderItems()
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
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize))
  $('#pageInfo').textContent = `第 ${state.page} / ${totalPages} 页 · 共 ${state.total} 条`
  $('#prevPage').disabled = state.page <= 1
  $('#nextPage').disabled = !(state.page * state.pageSize < state.total)
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
        const st = p.cancelled ? '停止中' : p.stage === 'translate' ? '翻译中' : p.stage === 'score' ? '评分中' : p.stage === 'judge' ? '过滤中' : '抓取中'; b.textContent = `⏹ ${st}(${p.done}/${p.total}) 点我取消`; b.disabled = false; markFetchingSrc(p.current)
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

// 停留今日精选期间：30s 一查所看日期的 digest 文件,内容变了就重渲（定时生成的新快报/新日报自动上屏）
setInterval(() => {
  if ($('#tab-digest')?.hidden || state.generating) return
  const day = $('#digestDay').value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return
  api(`/digest/${day}${state.digestKind === 'hourly' ? '?kind=hourly' : ''}`)
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

// ---- 今日精选日报 ----

const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
async function loadDigest() {
  const ld = new Date()
  const localDay = dayStr(ld)
  const dv = $('#digestDay').value.trim()
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dv) ? dv : localDay // 本地日界：UTC toISOString 会让凌晨看到的日期停在昨天
  $('#digestDay').value = day
  $('#digestView').dataset.kind = state.digestKind // 字号变量按 kind 取（--fz-digest/--fz-hourly）
  try {
    const r = await api(`/digest/${day}${state.digestKind === 'hourly' ? '?kind=hourly' : ''}`)
    state.digestRendered = r.markdown
    $('#digestView').innerHTML = mdLite(r.markdown)
    injectDayNav(day)
    injectHourNav()
    injectDomainNav()
    injectFzCtl()
  } catch {
    // 该天无日报但有快报 → 自动切快报展示（同一天的内容优先于跨天回退）
    if (state.digestKind === 'digest') {
      try {
        const r = await api(`/digest/${day}?kind=hourly`)
        state.digestKind = 'hourly'
        $('#digestView').dataset.kind = 'hourly'
        syncRunBtn()
        state.digestRendered = r.markdown
        $('#digestView').innerHTML = mdLite(r.markdown)
        injectDayNav(day)
        injectHourNav()
        injectDomainNav()
        injectFzCtl()
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
        injectDayNav(yday)
        injectHourNav()
        injectDomainNav()
        injectFzCtl()
        return
      } catch { /* 前一天也没有→走空态 */ }
    }
    state.digestRendered = ''
    const kindLabel = state.digestKind === 'hourly' ? '快报' : '日报'
    $('#digestView').innerHTML = state.generating
      ? `<p class="empty">⏳ ${kindLabel}生成中，请稍候…</p>`
      : `<p class="empty">${esc(day)} 无${kindLabel}（未到生成时间或抓取为空），可点「生成${kindLabel}」手动触发。</p>`
  }
}

/** 日报标题两侧的前后日导航：相邻日有对应文件才显示箭头 */
async function injectDayNav(day) {
  const h1 = $('#digestView h1')
  if (!h1 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return
  const probe = async (delta) => {
    for (let i = 1; i <= 14; i++) { // 跳过没产出日报的日子（宕机/无数据），最多找 14 天
      const d = new Date(`${day}T00:00:00`); d.setDate(d.getDate() + delta * i)
      const ds = dayStr(d)
      try { await api(`/digest/${ds}${state.digestKind === 'hourly' ? '?kind=hourly' : ''}`); return ds } catch { /* 这天没有→继续找 */ }
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
  const secs = [...document.querySelectorAll('#digestView h2')].filter((h) => /^\d{2}:\d{2}\s*时段快报/.test(h.textContent.trim()))
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

// 节标题右侧字号控件：委托到 #digestView（缩放作用于当前 kind 对应视图）
$('#digestView').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-fz]')
  if (b) fzStep(b.dataset.fz, +b.dataset.d)
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
  if (state.digestKind === 'hourly') { b.textContent = '▶ 生成快报'; b.title = '抓取新条目并评分生成本时段快报' }
  else { b.textContent = '▶ 生成日报'; b.title = '立即生成今日日报' }
}
for (const [id, kind] of [['btnKindDigest', 'digest'], ['btnKindHourly', 'hourly']]) {
  $(`#${id}`).addEventListener('click', () => {
    state.digestKind = kind
    $('#btnKindDigest').classList.toggle('active', kind === 'digest')
    $('#btnKindHourly').classList.toggle('active', kind === 'hourly')
    syncRunBtn(); loadDigest()
  })
}
// 抓取管线（抓取/翻译/评分/快报）进度文案：stage 分段 + done/total + 当前源域名；cancelled 时显示停止中
const fetchProgText = (p, prefix = '') => {
  const st = p.cancelled ? '停止中' : p.stage === 'translate' ? '翻译中' : p.stage === 'score' ? '评分中' : '抓取中'
  let cur = ''
  try { if (p.current) cur = ` · ${new URL(p.current).hostname}` } catch { /* 畸形 URL 不显示 */ }
  return `⏳ ${prefix}${st}…${p.total ? ` (${p.done}/${p.total})` : ''}${cur}`
}
// 日报生成进度轮询：手动点击与 iframe 重挂后的状态恢复共用
function startDigestWatch(reset) {
  const dp = setInterval(async () => {
    try {
      const p = await api('/digest-progress')
      if (p.running) { const stage = p.stage === 'translate' ? '翻译中' : p.stage === 'score' ? '评分中' : p.stage === 'finishing' ? '收尾中' : '日报生成中'; $('#digestBusy').textContent = `⏳ ${stage}…${p.total ? ` (${p.done}/${p.total})` : ''}`; return }
      clearInterval(dp); reset(); toast(p.cancelled ? '已按请求停止' : '日报生成完成'); loadDigest()
    } catch { /* 进度不可达不影响生成 */ }
  }, 900)
  return dp
}
// iframe 重挂后恢复：state.generating 归零但后端还在跑——探测一次，在跑就恢复生成中 UI 续轮询
async function resumeDigestIfRunning() {
  try {
    // 快报/定时抓取管线：与日报共用 busy 条+停止键（停止键按在跑管线分别走 /fetch-cancel、/digest-stop）
    const f = await api('/fetch-progress').catch(() => null)
    if (f?.running) {
      $('#digestBusy').hidden = false
      $('#btnDigestStop').hidden = false
      $('#digestBusy').textContent = fetchProgText(f)
      const poll = setInterval(async () => {
        try {
          const q = await api('/fetch-progress')
          if (q.running) {
            if (!state.generating) { // 日报生成占条时让位：不抢文本也不互相隐藏
              $('#digestBusy').hidden = false
              $('#digestBusy').textContent = fetchProgText(q)
              $('#btnDigestStop').hidden = false
            }
            return
          }
          clearInterval(poll)
          if (!state.generating) { $('#digestBusy').hidden = true; $('#btnDigestStop').hidden = true }
          loadDigest()
        } catch { /* 进度不可达不阻塞 */ }
      }, 1500) // 无超时上限：抓取+评分可超 2min——挂到真正结束，停止键全程可用
    }
    const p = await api('/digest-progress')
    if (!p.running) return
    const btn = $('#btnDigestRun')
    btn.disabled = true; btn.hidden = true
    $('#btnDigestStop').hidden = false
    $('#digestBusy').hidden = false
    const reset = () => { state.generating = false; btn.disabled = false; btn.hidden = false; $('#btnDigestStop').hidden = true; $('#digestBusy').hidden = true }
    state.generating = true
    const dp = startDigestWatch(reset)
    $('#digestBusy').textContent = '⏳ 日报生成中…'
  } catch { /* 探测失败按未运行 */ }
}
resumeDigestIfRunning()

$('#btnDigestRun').addEventListener('click', async () => {
  const btn = $('#btnDigestRun')
  btn.disabled = true; btn.hidden = true // 生成中隐藏入口，防重入
  $('#btnDigestStop').hidden = false
  $('#digestBusy').hidden = false
  const reset = () => { state.generating = false; btn.disabled = false; btn.hidden = false; $('#btnDigestStop').hidden = true; $('#digestBusy').hidden = true }
  state.generating = true
  const dp = startDigestWatch(reset)
  if (state.digestKind === 'hourly') { // 快报=抓取+评分产出：跑一轮 fetch 自然生成
    clearInterval(dp)
    // 生成始终针对今天：跨零点时日期框可能还停在昨天（日报回退改的），先拨回本地当天
    $('#digestDay').value = dayStr(new Date())
    $('#digestBusy').textContent = '⏳ 快报生成中…（抓取+评分）'
    try {
      await post('/fetch', { force: true })
      toast('已开始抓取+评分，快报稍后生成')
      const poll = setInterval(async () => {
        try {
          const p = await api('/fetch-progress')
          if (p.running) { $('#digestBusy').textContent = fetchProgText(p, '快报生成·'); return }
          clearInterval(poll); reset(); toast(p.cancelled ? '已按请求停止' : '快报已生成'); loadDigest()
        } catch { /* 进度不可达不阻塞 */ }
      }, 1500) // 无超时上限：抓取+评分远超 2min——挂到真正结束才收尾，期间停止键可取消
    } catch (e) { toast(`生成失败: ${e.message}`); reset() }
    return
  }
  $('#digestBusy').textContent = '⏳ 日报生成中…（LLM 总结可能要几分钟）' // 忙文走 busybar，statusbar 保持状态行
  try {
    // 异步触发：大条数下 LLM 全链路远超 HTTP 请求超时，服务端立即返回，轮询收尾
    await post('/digest-run', { force: true, day: $('#digestDay').value.trim() || undefined })
    toast('已开始生成，进度见上方横幅')
  } catch (e) { toast(`生成失败: ${e.message}`); clearInterval(dp); reset() }
})
let retryPoll = 0
async function refreshRetryBtn() {
  const btn = $('#btnRetryAll')
  try {
    const p = await api('/fetch-progress')
    if (p.running) btn.textContent = `重试中(${p.done}/${p.total})`
    else { btn.textContent = '↻ 重试全部失败源'; if (retryPoll) { clearInterval(retryPoll); retryPoll = 0 } loadSources(); loadStatus() }
  } catch { btn.textContent = '↻ 重试全部失败源' }
}
$('#btnRetryAll').addEventListener('click', async () => {
  try {
    const p = await api('/fetch-progress')
    if (p.running) { await post('/fetch-cancel', {}); toast('已请求取消，在飞的源收尾后停止'); return }
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
  // 停止键对在跑管线分别生效：抓取/翻译/评分/快报 → /fetch-cancel，日报生成 → /digest-stop；都在跑则都停
  try {
    const [f, d] = await Promise.all([api('/fetch-progress').catch(() => null), api('/digest-progress').catch(() => null)])
    if (!f?.running && !d?.running) { toast('当前没有正在运行的任务'); return }
    const names = []
    if (f?.running) { try { await post('/fetch-cancel', {}); names.push('抓取/评分') } catch { /* 单条失败不挡另一条 */ } }
    if (d?.running) { try { await post('/digest-stop', {}); names.push('日报生成') } catch { /* 同上 */ } }
    toast(names.length ? `已请求停止${names.join('和')}，在飞的调用收尾后结束` : '停止请求失败')
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
    renderPrefs()
    $('#proxyUrl').value = r.prefs.proxyUrl || ''
    const d = r.prefs.digestOpts || {}
    for (const [id, k] of [['dItems','digestItems'],['dPerTopic','perTopicLimit'],['dMinScore','minLlmScore'],['dScoreN','llmScoreCandidates'],['dCandH','candidateHours'],['dSumN','summaryMaxItems'],['dConc','summaryConcurrency'],['dSumLen','digestMaxLength'],['dRetDays','retentionDays'],['dMaxItems','storeMaxItems']]) $(`#${id}`).value = d[k] ?? ''
    $('#dScoreFetch').checked = d.scoreOnFetch !== false
    $('#dRescore').checked = d.rescoreMissing !== false
    $('#dHourly').checked = d.hourlyBrief !== false
    $('#dPruneQ').checked = d.pruneLowQuality !== false
    $('#stubZh').value = r.prefs.stubLimits?.zh ?? ''
    $('#stubEn').value = r.prefs.stubLimits?.en ?? ''
    $('#stubList').value = (r.prefs.contentBlocklist || []).join('\n')
    renderSubTopics(r.prefs)
  } catch { /* ignore */ }
}
const saveProxy = async () => {
  try {
    await post('/prefs', { proxyUrl: $('#proxyUrl').value.trim() || undefined })
    toast('全局代理已保存')
  } catch (e) { toast(`保存失败: ${e.message}`) }
}
$('#proxyUrl').addEventListener('input', debounce(saveProxy))
$('#btnProxySave')?.remove()
const saveDigestOpts = async () => {
  const num = (id) => { const v = $(`#${id}`).value.trim(); return v === '' ? undefined : Number(v) }
  try {
    const r = await post('/prefs', { digestOpts: { digestItems: num('dItems'), perTopicLimit: num('dPerTopic'), minLlmScore: num('dMinScore'), llmScoreCandidates: num('dScoreN'), candidateHours: num('dCandH'), summaryMaxItems: num('dSumN'), summaryConcurrency: num('dConc'), digestMaxLength: num('dSumLen'), scoreOnFetch: $('#dScoreFetch').checked, rescoreMissing: $('#dRescore').checked, hourlyBrief: $('#dHourly').checked, retentionDays: num('dRetDays'), pruneLowQuality: $('#dPruneQ').checked, storeMaxItems: num('dMaxItems') } })
    state.prefs = r.prefs
    toast('日报参数已保存')
  } catch (e) { toast(`保存失败: ${e.message}`) }
}
for (const id of ['dItems', 'dPerTopic', 'dMinScore', 'dScoreN', 'dCandH', 'dSumN', 'dConc', 'dSumLen', 'dRetDays', 'dMaxItems']) $(`#${id}`)?.addEventListener('input', debounce(saveDigestOpts))
for (const id of ['dScoreFetch', 'dRescore', 'dHourly', 'dPruneQ']) $(`#${id}`)?.addEventListener('change', saveDigestOpts)
$('#btnDigestOptsSave')?.remove()
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
$('#btnSubSave')?.remove()
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
$('#btnTlSave')?.remove()

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
$('#btnLlmSave')?.remove()
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
$('#btnSchedSave')?.remove()
$('#btnSchedClear').addEventListener('click', async () => {
  await post('/schedule', { clear: true })
  toast('已恢复配置默认')
  loadSchedule()
})

// ---- 危险区：二次确认删除（共用武装模式） ----
{
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
}

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
const fmtTok = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
function renderStats() {
  const body = $('#statsBody'); if (!body || !statsData) return
  const view = $('#statsView').value, range = +$('#statsRange').value
  const days = Object.entries(statsData.days || {}).sort((a, b) => b[0].localeCompare(a[0]))
  const filtered = range ? days.slice(0, range) : days
  if (view === 'day') {
    body.innerHTML = filtered.map(([d, v]) =>
      `<div class="hist-item"><span>${d}</span><span>日报 ${fmtTok(v.digest)} · 评分 ${fmtTok(v.score)} · 翻译 ${fmtTok(v.translate)} · 计 ${fmtTok(v.in + v.out)}</span></div>`).join('') || '<p class="empty">暂无数据</p>'
  } else if (view === 'feature') {
    const agg = { digest: 0, score: 0, translate: 0 }
    for (const [, v] of filtered) { agg.digest += v.digest; agg.score += v.score; agg.translate += v.translate }
    body.innerHTML = [['日报', agg.digest], ['评分/快报', agg.score], ['翻译', agg.translate]]
      .map(([k, v]) => `<div class="hist-item"><span>${k}</span><span>${fmtTok(v)} tok</span></div>`).join('')
  } else {
    body.innerHTML = `<div class="hist-item"><span>总输入</span><span>${fmtTok(statsData.totalIn)} tok</span></div>`
      + `<div class="hist-item"><span>总输出</span><span>${fmtTok(statsData.totalOut)} tok</span></div>`
      + `<div class="hist-item"><span>合计</span><span>${fmtTok(statsData.totalIn + statsData.totalOut)} tok</span></div>`
  }
}
$('#statsView')?.addEventListener('change', renderStats)
$('#statsRange')?.addEventListener('change', renderStats)
let verClicks = 0, verTimer = 0
$('#versionTag')?.addEventListener('click', () => {
  clearTimeout(verTimer); verTimer = setTimeout(() => { verClicks = 0 }, 1500)
  if (++verClicks >= 10) {
    verClicks = 0; $('#statsSection').hidden = false
    $('#statsDetails').hidden = false; $('#statsDetails').open = true
    api('/status').then((s) => { statsData = s.tokenStats; renderStats() })
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
api('/status').then((s) => { if (s.version) $('#versionTag').textContent = `v${s.version}`; if (s.tokenStats) statsData = s.tokenStats }).catch(() => {})

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
    $('#statusbar').hidden = btn.dataset.tab === 'digest'
    if (btn.dataset.tab === 'digest') {
      const today = dayStr(new Date())
      const sel = $('#digestDay').value
      // 输入框非今天→复位今天；除非框里就是用户今天亲手选的日期（回退写入的昨天不算主动选择）
      if (sel && sel !== today && !(state.daySetOn === today && sel === state.dayPicked)) $('#digestDay').value = today
      loadDigest()
    }
    if (btn.dataset.tab === 'sources') loadSources()
    if (btn.dataset.tab === 'prefs') { loadPrefs(); enqueueLlm(loadLlm); loadSchedule() }
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
if (state.digestKind === 'hourly') $('.tab[data-tab="digest"]')?.click() // ?kind=hourly 直达快报页
loadStatus(); loadSources().then(async () => { await loadItems(); if (pendingPos?.id) scrollToAnchor(pendingPos) })
setInterval(loadStatus, 2000) // 未读计数 2s 轮询
