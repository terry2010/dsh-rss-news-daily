/* dsh-rss-news-daily 阅读器（零构建，原生 JS）。全部数据走 /dsh-rss-news-daily/api/* */
const API = '/dsh-rss-news-daily/api'

// 主题跟随宿主：?theme= 管首屏不闪，postMessage 管之后明暗切换不重载
const applyTheme = (t) => { if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t }
applyTheme(new URLSearchParams(location.search).get('theme'))
window.addEventListener('message', (e) => { if (e.data && e.data.type === 'rnd-theme') applyTheme(e.data.theme) })

const state = { page: 1, items: [], sources: [], prefs: null, digestDay: '', digestKind: 'digest', generating: false, total: 0, pageSize: 50 }
const $ = (sel) => document.querySelector(sel)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
/** 输出链接白名单：只放行 http(s)，javascript:/data: 一律清空 */
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '')

async function api(path, opts) {
  const res = await fetch(`${API}${path}`, opts)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function toast(msg) {
  const el = $('#toastbar')
  el.textContent = msg
  clearTimeout(toast._t)
  toast._t = setTimeout(loadStatus, 3000)
}

async function loadStatus() {
  try {
    const s = await api('/status')
    $('#statusbar').textContent = `${s.enabled}/${s.sources} 源 · 今日+${s.todayAdded ?? 0} · 本次+${s.lastAdded ?? 0} · 共${s.items} 条 · ${s.failures?.length ? `${s.failures.length} 源异常${s.cooling ? `（${s.cooling} 冷却中）` : ''}` : '健康'}`
  } catch { $('#statusbar').textContent = '状态不可用' }
}

// ---- 条目流 ----

async function loadItems() {
  const p = new URLSearchParams()
  if ($('#q').value) p.set('q', $('#q').value)
  if (/^\d{4}-\d{2}-\d{2}$/.test($('#day').value.trim())) p.set('day', $('#day').value.trim()) // 非 yyyy-mm-dd 不参与过滤
  if ($('#category').value) p.set('category', $('#category').value)
  if ($('#srcFilter').value) p.set('source', $('#srcFilter').value)
  if ($('#unread').checked) p.set('unread', '1')
  p.set('page', state.page)
  try {
    const r = await api(`/items?${p}`)
    state.items = r.items; state.total = r.total; state.pageSize = r.pageSize
    renderItems()
  } catch (e) { $('#itemList').innerHTML = `<p class="err">加载失败: ${esc(e.message)}</p>` }
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

function itemHtml(i) {
    const st = i.state || {} // 老数据可能缺 state 字段——防御，防整个渲染挂掉（"翻页没反应"）
    return `
    <div class="item ${st.read ? 'read collapsed' : ''} ${st.liked === 1 ? 'liked' : ''}" data-id="${esc(i.id)}">
      <div class="item-head">
        ${(() => { if (i.aiSummary || state.tlHidden?.has(i.id)) return ''; const t = (st.translation || '').trim(); const nl = t.indexOf('\n'); return t ? `<div style="color:var(--acc)">译: ${esc((nl > 0 ? t.slice(0, nl) : t).trim())}</div>` : '' })()}
        <a href="${esc(safeUrl(i.link) || '#')}" target="_blank" rel="noopener">${esc(i.title)}</a>
      </div>
      <div class="item-meta">${esc(i.topic)} · ${(() => { const d = new Date(i.publishedAt || i.fetchedAt); const p = (n) => String(n).padStart(2, '0'); return isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` })()}${i.digestedDay ? ' · 已入日报' : ''}${i.reasons?.length ? ` · <i>${esc(i.reasons.join('、'))}</i>` : ''}${(() => {
        if (i.aiSummary) return '' // 已有中文核心事实，不再提供翻译
        const t = i.title + (i.summary || '')
        const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length
        if (cjk * 2 > t.replace(/\s/g, '').length) return ''
        if (state.translating === i.id) return ' <button disabled title="翻译中">翻译中…</button>'
        if (st.translation) return ` <button data-act="translate" data-id="${esc(i.id)}" title="重新翻译">重译</button>${state.tlHidden?.has(i.id) ? ` <button data-act="showtl" data-id="${esc(i.id)}" title="显示译文">显示翻译</button>` : ` <button data-act="hidetl" data-id="${esc(i.id)}" title="隐藏译文">隐藏翻译</button>`}`
        return ` <button data-act="translate" data-id="${esc(i.id)}" title="翻译成中文">译</button>`
      })()}</div>
      <div class="item-lead">${esc((i.aiSummary || i.summary || '').slice(0, 140))}</div>
      ${(() => { if (i.aiSummary || state.tlHidden?.has(i.id)) return ''; const t = (st.translation || '').trim(); const nl = t.indexOf('\n'); const body = nl > 0 ? t.slice(nl).replace(/\s+/g, ' ').trim() : t; return body && nl > 0 ? `<div class="item-lead" style="color:var(--acc)">译: ${esc(body.slice(0, 240))}</div>` : '' })()}
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
// 翻页后滚回列表顶部（pager 在页脚，不滚会停在页底）
const toTop = () => window.scrollTo(0, 0)
$('#prevPage').addEventListener('click', () => { if (state.page > 1) { state.page--; loadItems().then(toTop) } })
$('#nextPage').addEventListener('click', () => { if (state.page * state.pageSize < state.total) { state.page++; loadItems().then(toTop) } })
$('#btnFetch').addEventListener('click', async () => {
  const src = $('#srcFilter').value, cat = $('#category').value
  toast('抓取中…')
  try { const r = await post('/fetch', { force: true, source: src || undefined, category: src ? undefined : (cat || undefined) }); toast(`抓取完成: +${r.added} 条`); loadItems(); loadStatus() }
  catch (e) { toast(`抓取失败: ${e.message}`) }
})

$('#autoTranslate').addEventListener('change', async (e) => {
  $('#autoTlWarn').hidden = !e.target.checked
  try { const r = await post('/prefs', { autoTranslate: e.target.checked }); state.prefs = r.prefs || state.prefs; toast(e.target.checked ? '已开启自动翻译' : '已关闭自动翻译') }
  catch (err) { toast(`保存失败: ${err.message}`) }
})

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }

// ---- 今日精选日报 ----

async function loadDigest() {
  const ld = new Date()
  const localDay = `${ld.getFullYear()}-${String(ld.getMonth() + 1).padStart(2, '0')}-${String(ld.getDate()).padStart(2, '0')}`
  const dv = $('#digestDay').value.trim()
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dv) ? dv : localDay // 本地日界：UTC toISOString 会让凌晨看到的日期停在昨天
  $('#digestDay').value = day
  try {
    const r = await api(`/digest/${day}${state.digestKind === 'hourly' ? '?kind=hourly' : ''}`)
    $('#digestView').innerHTML = mdLite(r.markdown)
  } catch {
    const kindLabel = state.digestKind === 'hourly' ? '快报' : '日报'
    $('#digestView').innerHTML = state.generating
      ? `<p class="empty">⏳ ${kindLabel}生成中，请稍候…</p>`
      : `<p class="empty">${esc(day)} 无${kindLabel}（未到生成时间或抓取为空），可点「生成${kindLabel}」手动触发。</p>`
  }
}

/** 轻量 Markdown 渲染：标题/列表/链接/引用，够日报用 */
function mdLite(md) {
  const link = (t) => t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  return esc(md).split('\n').map((l) => {
    const e = link(l)
    if (e.startsWith('# ')) return `<h1>${e.slice(2)}</h1>`
    if (e.startsWith('## ')) return `<h2>${e.slice(3)}</h2>`
    if (e.startsWith('&gt;')) return `<blockquote>${e.slice(4)}</blockquote>`
    if (/^\d+\.\s/.test(e)) return `<p class="md-num">${e}</p>`
    if (e.startsWith('- ')) return `<p class="md-li">• ${e.slice(2)}</p>`
    if (e.startsWith('---')) return '<hr>'
    return e.trim() ? `<p>${e}</p>` : ''
  }).join('')
}

$('#digestDay').addEventListener('change', loadDigest)
const syncRunBtn = () => {
  const b = $('#btnDigestRun')
  if (state.digestKind === 'hourly') { b.textContent = '▶ 生成快报'; b.title = '抓取新条目并评分生成本时段快报' }
  else { b.textContent = '▶ 生成日报'; b.title = '立即生成今日日报' }
}
for (const [id, kind] of [['btnKindDigest', 'digest'], ['btnKindHourly', 'hourly']]) {
  $(`#${id}`).addEventListener('click', () => { state.digestKind = kind; syncRunBtn(); loadDigest() })
}
$('#btnDigestRun').addEventListener('click', async () => {
  const btn = $('#btnDigestRun')
  btn.disabled = true; btn.hidden = true // 生成中隐藏入口，防重入
  $('#btnDigestStop').hidden = false
  $('#digestBusy').hidden = false
  const reset = () => { state.generating = false; btn.disabled = false; btn.hidden = false; $('#btnDigestStop').hidden = true; $('#digestBusy').hidden = true }
  state.generating = true
  const dp = setInterval(async () => {
    try {
      const p = await api('/digest-progress')
      if (p.running) { const stage = p.stage === 'translate' ? '翻译中' : p.stage === 'finishing' ? '收尾中' : '日报生成中'; $('#digestBusy').textContent = `⏳ ${stage}…${p.total ? ` (${p.done}/${p.total})` : ''}`; return }
      clearInterval(dp); reset(); toast('日报生成完成'); loadDigest()
    } catch { /* 进度不可达不影响生成 */ }
  }, 900)
  if (state.digestKind === 'hourly') { // 快报=抓取+评分产出：跑一轮 fetch 自然生成
    clearInterval(dp)
    $('#digestBusy').textContent = '⏳ 快报生成中…（抓取+评分）'
    try {
      await post('/fetch', { force: true })
      toast('已开始抓取+评分，快报稍后生成')
      const poll = setInterval(async () => {
        try {
          const p = await api('/fetch-progress')
          if (!p.running) { clearInterval(poll); reset(); toast('快报已生成'); loadDigest() }
        } catch { /* 进度不可达不阻塞 */ }
      }, 1500)
      setTimeout(() => { clearInterval(poll); reset(); loadDigest() }, 120_000) // 2min 兜底
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
    const r = await post('/fetch', { force: true, onlyFailed: true })
    toast(`重试完成: +${r.added} 条${r.errors ? ` · ${r.errors} 仍失败` : ''}`)
    loadSources(); loadStatus()
  } catch (e) { toast(`重试失败: ${e.message}`) }
  finally { if (retryPoll) { clearInterval(retryPoll); retryPoll = 0 } $('#btnRetryAll').textContent = '↻ 重试全部失败源' }
})
$('#btnDigestStop').addEventListener('click', async () => {
  try { await post('/digest-stop', {}); toast('已请求停止，正在降级收尾…') }
  catch (e) { toast(`停止失败: ${e.message}`) }
})

// ---- 订阅源管理 ----

async function loadSources() {
  try {
    const r = await api('/sources')
    state.sources = r.sources
    renderSources()
    fillFilters(r.sources)
  } catch (e) { $('#srcList').innerHTML = `<p class="err">${esc(e.message)}</p>` }
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
        ${s.builtin ? '' : `<button data-src-act="del" data-id="${esc(s.url)}">删除</button>`}
      </div>
    </div>
    ${state.editing === s.id ? `
    <div class="src-edit">
      <label class="wide">URL <input data-f="url" value="${esc(s.url)}"></label>
      <label>名称 <input data-f="title" value="${esc(s.title)}"></label>
      <label>分类 <select data-f="category"><option value="">无分类</option>${[...new Set([s.category, ...state.sources.map((x) => x.category)].filter(Boolean))].map((c) => `<option ${c === s.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="__new">＋ 自定义…</option></select><input data-f="categoryNew" placeholder="新分类名" hidden></label>
      <label><input type="checkbox" data-f="enabled" ${s.enabled ? 'checked' : ''}> 启用</label>
      <label><input type="checkbox" data-f="summarize" ${s.summarize !== false ? 'checked' : ''}> AI 摘要</label>
      <label><input type="checkbox" data-f="useProxy" ${s.proxy === true || typeof s.proxy === 'string' ? 'checked' : ''}> 使用代理</label>
      <label>最小冷却小时 <input type="number" min="0" step="1" data-f="cooldownHours" value="${s.cooldownHours ?? ''}" placeholder="24"></label>
      <button data-src-act="save" data-id="${esc(s.url)}">保存</button>
      <button data-src-act="cancel">取消</button>
    </div>` : ''}
    </div>`).join('')
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
$('#srcList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-src-act]')
  if (!btn) return
  const id = encodeURIComponent(btn.dataset.id)
  try {
    if (btn.dataset.srcAct === 'toggle') {
      await api(`/sources/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: btn.dataset.en === '1' }) })
    } else if (btn.dataset.srcAct === 'retry') {
      toast('重试中（抓取可能需几秒）…')
      await api(`/sources/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'retry' }) })
      const s2 = (await api('/sources')).sources.find((x) => encodeURIComponent(x.url) === id)
      toast(s2?.health?.lastError ? `仍失败: ${s2.health.lastError.slice(0, 60)}` : `已恢复: ✓ ${s2?.health?.ok ?? 0} 次成功`)
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

$('#btnAddSrc').addEventListener('click', async () => {
  const url = $('#newSrcUrl').value.trim()
  if (!url) return toast('请输入 feed URL')
  toast('校验并添加中…')
  try {
    await post('/sources', { url, title: $('#newSrcTitle').value.trim() || undefined, category: $('#newSrcCatNew').value.trim() || $('#newSrcCat').value || undefined })
    $('#newSrcUrl').value = ''; $('#newSrcTitle').value = ''
    toast(`已添加${r?.category ? ` · 分类: ${r.category}` : ''}`); loadSources()
  } catch (e) { toast(`添加失败: ${e.message}`) }
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
    renderPrefs()
    $('#proxyUrl').value = r.prefs.proxyUrl || ''
    const d = r.prefs.digestOpts || {}
    for (const [id, k] of [['dItems','digestItems'],['dPerTopic','perTopicLimit'],['dMinScore','minLlmScore'],['dScoreN','llmScoreCandidates'],['dCandH','candidateHours'],['dSumN','summaryMaxItems'],['dConc','summaryConcurrency'],['dSumLen','digestMaxLength'],['dRetDays','retentionDays']]) $(`#${id}`).value = d[k] ?? ''
    $('#dScoreFetch').checked = d.scoreOnFetch !== false
    $('#dRescore').checked = d.rescoreMissing !== false
    $('#dHourly').checked = d.hourlyBrief !== false
    $('#dPruneQ').checked = d.pruneLowQuality !== false
    renderSubTopics(r.prefs)
  } catch { /* ignore */ }
}
$('#btnProxySave').addEventListener('click', async () => {
  try {
    await post('/prefs', { proxyUrl: $('#proxyUrl').value.trim() || undefined })
    toast('全局代理已保存，下次抓取生效')
  } catch (e) { toast(`保存失败: ${e.message}`) }
})
$('#btnDigestOptsSave').addEventListener('click', async () => {
  const num = (id) => { const v = $(`#${id}`).value.trim(); return v === '' ? undefined : Number(v) }
  try {
    const r = await post('/prefs', { digestOpts: { digestItems: num('dItems'), perTopicLimit: num('dPerTopic'), minLlmScore: num('dMinScore'), llmScoreCandidates: num('dScoreN'), candidateHours: num('dCandH'), summaryMaxItems: num('dSumN'), summaryConcurrency: num('dConc'), digestMaxLength: num('dSumLen'), scoreOnFetch: $('#dScoreFetch').checked, rescoreMissing: $('#dRescore').checked, hourlyBrief: $('#dHourly').checked, retentionDays: num('dRetDays'), pruneLowQuality: $('#dPruneQ').checked } })
    state.prefs = r.prefs
    toast('日报参数已保存，下次生成生效')
  } catch (e) { toast(`保存失败: ${e.message}`) }
})
function renderSubTopics(p) {
  const cats = [...new Set((state.sources || []).map((src) => src.category).filter(Boolean))].sort()
  const subs = p?.subscribedTopics // undefined=全订阅
  $('#subTopics').innerHTML = cats.length ? cats.map((c) =>
    `<label><input type="checkbox" class="subTopic" value="${esc(c)}" ${!subs || subs.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('')
    : '<span class="empty">暂无分类</span>'
}
$('#btnSubSave').addEventListener('click', async () => {
  const checked = [...document.querySelectorAll('.subTopic')].filter((c) => c.checked).map((c) => c.value)
  const all = checked.length === document.querySelectorAll('.subTopic').length
  try {
    const r = await post('/prefs', { subscribedTopics: all ? [] : checked }) // []=全订阅（undefined 会被 merge 保留旧值）
    state.prefs = r.prefs; renderSubTopics(r.prefs)
    toast(all ? '已订阅全部分类' : `已订阅 ${checked.length} 个分类`)
  } catch (e) { toast(`保存失败: ${e.message}`) }
})
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
    + '<button id="btnWeightsSave" style="margin-top:8px">保存权重</button>'
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
  if (btn.dataset.wtDel) { delete w[btn.dataset.wtDel][btn.dataset.k]; state.prefs = { ...state.prefs, ...w }; renderPrefs(); return }
  if (btn.dataset.wtAdd) {
    const name = btn.parentElement.querySelector('input').value.trim()
    if (!name) return
    w[btn.dataset.wtAdd][name] = 1.0; state.prefs = { ...state.prefs, ...w }; renderPrefs(); return
  }
  if (btn.dataset.banDel) { w.bannedKeywords = w.bannedKeywords.filter((k) => k !== btn.dataset.banDel); state.prefs = { ...state.prefs, ...w }; renderPrefs(); return }
  if (btn.id === 'banAdd') {
    const v = $('#banNew').value.trim()
    if (v && !w.bannedKeywords.includes(v)) w.bannedKeywords.push(v)
    state.prefs = { ...state.prefs, ...w }; renderPrefs(); return
  }
  if (btn.id === 'btnWeightsSave') {
    try { const r = await post('/prefs', w); state.prefs = r.prefs || state.prefs; renderPrefs(); toast('权重已保存') }
    catch (err) { toast(`保存失败: ${err.message}`) }
  }
})

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
    await loadLlmModels(r.current.provider || r.providers[0]?.id || '', r.current.model)
    // 翻译模型：独立覆盖，缺省跟随日报模型
    const t = state.prefs?.translateLlm
    $('#tlProvider').innerHTML = r.providers.map((p) =>
      `<option value="${esc(p.id)}" ${p.id === (t?.provider || r.current.provider) ? 'selected' : ''}>${esc(p.id)}</option>`).join('')
    await loadTlModels(t?.provider || r.current.provider || r.providers[0]?.id || '', t?.model || '')
    $('#tlInfo').textContent = t?.provider && t?.model ? `翻译模型: ${t.provider}/${t.model}` : '翻译模型: 跟随日报模型'
    $('#autoTranslate').checked = !!state.prefs?.autoTranslate
    $('#autoTlWarn').hidden = !$('#autoTranslate').checked
  } catch (e) { $('#llmInfo').textContent = `模型信息不可用: ${esc(e.message)}` }
}

async function loadTlModels(provider, selected) {
  if (!provider) return
  try {
    const r = await api(`/llm?provider=${encodeURIComponent(provider)}`)
    $('#tlModel').innerHTML = r.models.map((m) =>
      `<option value="${esc(m)}" ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('')
  } catch { /* provider 模型列表拉取失败留空 */ }
}

$('#tlProvider').addEventListener('change', (e) => loadTlModels(e.target.value, ''))
$('#btnTlSave').addEventListener('click', async () => {
  try {
    await post('/llm', { provider: $('#tlProvider').value, model: $('#tlModel').value, scope: 'translate' })
    toast('翻译模型已保存'); loadLlm()
  } catch (e) { toast(`保存失败: ${e.message}`) }
})

async function loadLlmModels(provider, selected) {
  if (!provider) return
  try {
    const r = await api(`/llm?provider=${encodeURIComponent(provider)}`)
    $('#llmModel').innerHTML = r.models.map((m) =>
      `<option value="${esc(m)}" ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('')
  } catch { /* provider 模型列表拉取失败留空 */ }
}

$('#llmProvider').addEventListener('change', (e) => loadLlmModels(e.target.value, ''))
$('#btnLlmSave').addEventListener('click', async () => {
  const provider = $('#llmProvider').value
  const model = $('#llmModel').value
  if (!provider || !model) return toast('provider 和 model 都要选')
  await post('/llm', { provider, model })
  toast('模型已保存，下次日报生效')
  loadLlm()
})
$('#btnLlmClear').addEventListener('click', async () => {
  await post('/llm', { provider: '', model: '' })
  toast('已恢复自动路由')
  loadLlm()
})

// ---- 定时调度 ----

// 每个时刻一行；首行 ＋ 新增空行，后续行 − 删除本行
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/
function timeRow(value, isFirst) {
  const row = document.createElement('div'); row.className = 'sched-row'
  const inp = document.createElement('input'); inp.type = 'time'; inp.value = value || ''
  const add = document.createElement('button')
  add.textContent = '＋'; add.title = '新增时刻'
  add.onclick = () => row.parentElement.appendChild(timeRow('', false))
  row.append(inp, add)
  if (!isFirst) { // 第二行起同时有 ＋ 和 −
    const del = document.createElement('button')
    del.textContent = '−'; del.title = '删除该时刻'
    del.onclick = () => row.remove()
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

$('#btnSchedSave').addEventListener('click', async () => {
  const digestTimes = collectTimes('#schedDigestRows')
  const fetchTimes = collectTimes('#schedFetchRows')
  const iv = $('#schedInterval').value.trim()
  await post('/schedule', { digestTimes, fetchTimes, intervalMinutes: iv === '' ? undefined : Number(iv), onStartup: $('#schedStartup').checked || undefined })
  toast('调度已保存，下一次挂钟生效')
  loadSchedule()
})
$('#btnSchedClear').addEventListener('click', async () => {
  await post('/schedule', { clear: true })
  toast('已恢复配置默认')
  loadSchedule()
})

// ---- 初始化 ----

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn))
    for (const sec of document.querySelectorAll('main > section')) sec.hidden = true
    $(`#tab-${btn.dataset.tab}`).hidden = false
    $('#statusbar').hidden = btn.dataset.tab === 'digest'
    if (btn.dataset.tab === 'digest') loadDigest()
    if (btn.dataset.tab === 'sources') loadSources()
    if (btn.dataset.tab === 'prefs') { loadPrefs(); loadLlm(); loadSchedule() }
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

loadStatus(); loadSources().then(async () => { await loadItems(); if (pendingPos?.id) scrollToAnchor(pendingPos) })
setInterval(loadStatus, 2000) // 未读计数 2s 轮询
