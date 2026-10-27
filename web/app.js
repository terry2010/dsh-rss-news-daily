/* dsh-rss-news-daily 阅读器（零构建，原生 JS）。全部数据走 /dsh-rss-news-daily/api/* */
const API = '/dsh-rss-news-daily/api'

const state = { page: 1, items: [], sources: [], prefs: null, digestDay: '', total: 0, pageSize: 50 }
const $ = (sel) => document.querySelector(sel)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

async function api(path, opts) {
  const res = await fetch(`${API}${path}`, opts)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function toast(msg) {
  const el = $('#statusbar')
  el.textContent = msg
  clearTimeout(toast._t)
  toast._t = setTimeout(loadStatus, 3000)
}

async function loadStatus() {
  try {
    const s = await api('/status')
    $('#statusbar').textContent = `${s.enabled}/${s.sources} 源 · ${s.items} 条 · ${s.failures?.length ? `${s.failures.length} 源异常` : '健康'}`
  } catch { $('#statusbar').textContent = '状态不可用' }
}

// ---- 条目流 ----

async function loadItems() {
  const p = new URLSearchParams()
  if ($('#q').value) p.set('q', $('#q').value)
  if ($('#day').value) p.set('day', $('#day').value)
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
  el.innerHTML = state.items.map((i) => `
    <div class="item ${i.state.read ? 'read' : ''} ${i.state.liked === 1 ? 'liked' : ''}">
      <div class="item-head">
        <a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.title)}</a>
      </div>
      <div class="item-meta">${esc(i.topic)} · ${new Date(i.publishedAt || i.fetchedAt).toLocaleString()}${i.digestedDay ? ' · 已入日报' : ''}${i.reasons?.length ? ` · <i>${esc(i.reasons.join('、'))}</i>` : ''}</div>
      <div class="item-lead">${esc((i.aiSummary || i.summary || '').slice(0, 140))}</div>
      <div class="item-actions">
        <button data-act="read" data-id="${esc(i.id)}" title="已读">✓</button>
        <button data-act="${i.state.liked === 1 ? 'unlike' : 'like'}" data-id="${esc(i.id)}">👍</button>
        <button data-act="dislike" data-id="${esc(i.id)}">👎</button>
        <button data-act="hide" data-id="${esc(i.id)}" title="隐藏">✕</button>
      </div>
    </div>`).join('')
  $('#pageInfo').textContent = `第 ${state.page} 页 / 共 ${state.total} 条`
}

$('#itemList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  try {
    await post('/feedback', { id: btn.dataset.id, action: btn.dataset.act })
    loadItems()
  } catch (err) { toast(`操作失败: ${err.message}`) }
})

for (const sel of ['#q', '#day', '#category', '#srcFilter', '#unread']) {
  $(sel).addEventListener('change', () => { state.page = 1; loadItems() })
}
$('#q').addEventListener('input', debounce(() => { state.page = 1; loadItems() }, 400))
$('#prevPage').addEventListener('click', () => { if (state.page > 1) { state.page--; loadItems() } })
$('#nextPage').addEventListener('click', () => { if (state.page * state.pageSize < state.total) { state.page++; loadItems() } })
$('#btnFetch').addEventListener('click', async () => {
  toast('抓取中…')
  try { const r = await post('/fetch', {}); toast(`抓取完成: +${r.added} 条`); loadItems() }
  catch (e) { toast(`抓取失败: ${e.message}`) }
})

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }

// ---- 今日精选日报 ----

async function loadDigest() {
  const day = $('#digestDay').value || new Date().toISOString().slice(0, 10)
  $('#digestDay').value = day
  try {
    const r = await api(`/digest/${day}`)
    $('#digestView').innerHTML = mdLite(r.markdown)
  } catch {
    $('#digestView').innerHTML = `<p class="empty">${esc(day)} 无日报（未到生成时间或抓取为空），可点「生成日报」手动触发。</p>`
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
$('#btnDigestRun').addEventListener('click', async () => {
  toast('生成日报中（LLM 总结可能要 1-2 分钟）…')
  try { await post('/digest-run', {}); toast('日报已生成'); loadDigest() }
  catch (e) { toast(`生成失败: ${e.message}`) }
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
  $('#srcList').innerHTML = state.sources.map((s) => `
    <div class="src ${s.enabled ? '' : 'off'}">
      <div class="src-info">
        <b>${esc(s.title)}</b> <span class="tag">${esc(s.category)}</span>${s.builtin ? '<span class="tag dim">内置</span>' : ''}
        <div class="src-url">${esc(s.url)}</div>
        ${s.health?.lastError ? `<div class="src-err">✗ ${esc(s.health.lastError)}${s.health.cooldownUntil ? ' · 冷却中' : ''}</div>` : `<div class="src-ok">✓ ${s.health?.ok || 0} 次成功${s.health?.avgMs ? ` · ${Math.round(s.health.avgMs)}ms` : ''}</div>`}
      </div>
      <div class="src-actions">
        <button data-src-act="toggle" data-id="${esc(s.url)}" data-en="${s.enabled ? 0 : 1}">${s.enabled ? '停用' : '启用'}</button>
        ${s.builtin ? '' : `<button data-src-act="del" data-id="${esc(s.url)}">删除</button>`}
      </div>
    </div>`).join('')
}

$('#srcList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-src-act]')
  if (!btn) return
  const id = encodeURIComponent(btn.dataset.id)
  try {
    if (btn.dataset.srcAct === 'toggle') {
      await api(`/sources/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: btn.dataset.en === '1' }) })
    } else {
      await api(`/sources/${id}`, { method: 'DELETE' })
    }
    loadSources()
  } catch (err) { toast(`操作失败: ${err.message}`) }
})

$('#btnAddSrc').addEventListener('click', async () => {
  const url = $('#newSrcUrl').value.trim()
  if (!url) return toast('请输入 feed URL')
  toast('校验并添加中…')
  try {
    await post('/sources', { url, title: $('#newSrcTitle').value.trim() || undefined })
    $('#newSrcUrl').value = ''; $('#newSrcTitle').value = ''
    toast('已添加'); loadSources()
  } catch (e) { toast(`添加失败: ${e.message}`) }
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
  } catch { /* ignore */ }
}

function renderPrefs() {
  const p = state.prefs || {}
  const rows = []
  for (const [k, v] of Object.entries(p.topics || {})) rows.push(`<div class="pref">主题 <b>${esc(k)}</b> × ${v}</div>`)
  for (const [k, v] of Object.entries(p.keywords || {})) rows.push(`<div class="pref">关键词 <b>${esc(k)}</b> × ${v}</div>`)
  for (const k of p.bannedKeywords || []) rows.push(`<div class="pref ban">屏蔽 <b>${esc(k)}</b></div>`)
  $('#prefsView').innerHTML = rows.length ? rows.join('') : '<p class="empty">暂无偏好记录——用上方的调教输入或在条目上点 👍👎 开始学习。</p>'
  const hist = (p.tuningHistory || []).slice(-5)
  if (hist.length) {
    $('#prefsView').innerHTML += '<h4>最近调教</h4>' + hist.map((h) => `<div class="hist">${esc(h.at?.slice(0, 16))} — ${esc(h.text)} <i>${(h.actions || []).join('; ')}</i></div>`).join('')
  }
}

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

// ---- 初始化 ----

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn))
    for (const sec of document.querySelectorAll('main > section')) sec.hidden = true
    $(`#tab-${btn.dataset.tab}`).hidden = false
    if (btn.dataset.tab === 'digest') loadDigest()
    if (btn.dataset.tab === 'sources') loadSources()
    if (btn.dataset.tab === 'prefs') loadPrefs()
  })
})

loadStatus(); loadSources().then(loadItems)
