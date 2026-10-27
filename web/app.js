/* dsh-rss-news-daily 阅读器（零构建，原生 JS）。全部数据走 /dsh-rss-news-daily/api/* */
const API = '/dsh-rss-news-daily/api'

// 主题跟随宿主：?theme= 管首屏不闪，postMessage 管之后明暗切换不重载
const applyTheme = (t) => { if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t }
applyTheme(new URLSearchParams(location.search).get('theme'))
window.addEventListener('message', (e) => { if (e.data && e.data.type === 'rnd-theme') applyTheme(e.data.theme) })

const state = { page: 1, items: [], sources: [], prefs: null, digestDay: '', total: 0, pageSize: 50 }
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
  const el = $('#statusbar')
  el.textContent = msg
  clearTimeout(toast._t)
  toast._t = setTimeout(loadStatus, 3000)
}

async function loadStatus() {
  try {
    const s = await api('/status')
    $('#statusbar').textContent = `${s.enabled}/${s.sources} 源 · ${s.items} 条 · ${s.failures?.length ? `${s.failures.length} 源异常${s.cooling ? `（${s.cooling} 冷却中）` : ''}` : '健康'}`
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
  el.innerHTML = state.items.map((i) => {
    const st = i.state || {} // 老数据可能缺 state 字段——防御，防整个渲染挂掉（"翻页没反应"）
    return `
    <div class="item ${st.read ? 'read collapsed' : ''} ${st.liked === 1 ? 'liked' : ''}">
      <div class="item-head">
        <a href="${esc(safeUrl(i.link) || '#')}" target="_blank" rel="noopener">${esc(i.title)}</a>
      </div>
      <div class="item-meta">${esc(i.topic)} · ${new Date(i.publishedAt || i.fetchedAt).toLocaleString()}${i.digestedDay ? ' · 已入日报' : ''}${i.reasons?.length ? ` · <i>${esc(i.reasons.join('、'))}</i>` : ''}</div>
      <div class="item-lead">${esc((i.aiSummary || i.summary || '').slice(0, 140))}</div>
      <div class="item-actions">
        <button data-act="${st.read ? 'unread' : 'read'}" data-id="${esc(i.id)}" title="${st.read ? '标为未读（展开简介）' : '标为已读（收起简介）'}">${st.read ? '◉' : '✓'}</button>
        <button data-act="${st.liked === 1 ? 'unlike' : 'like'}" data-id="${esc(i.id)}" title="推荐学习：以后多推同类">👍</button>
        <button data-act="dislike" data-id="${esc(i.id)}" title="少推学习：以后少推同类">👎</button>
        <button data-act="hide" data-id="${esc(i.id)}" title="从列表隐藏">✕</button>
        <button data-act="copy" data-id="${esc(i.id)}" data-link="${esc(safeUrl(i.link))}" title="复制链接">⧉</button>
      </div>
    </div>`
  }).join('')
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize))
  $('#pageInfo').textContent = `第 ${state.page} / ${totalPages} 页 · 共 ${state.total} 条`
  $('#prevPage').disabled = state.page <= 1
  $('#nextPage').disabled = !(state.page * state.pageSize < state.total)
}

$('#itemList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  if (btn.dataset.act === 'copy') {
    try { await navigator.clipboard.writeText(btn.dataset.link || ''); toast('链接已复制') }
    catch { toast('复制失败') }
    return
  }
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
$('#prevPage').addEventListener('click', () => { if (state.page > 1) { state.page--; loadItems() } })
$('#nextPage').addEventListener('click', () => { if (state.page * state.pageSize < state.total) { state.page++; loadItems() } })
$('#btnFetch').addEventListener('click', async () => {
  toast('抓取中…')
  try { const r = await post('/fetch', { force: true }); toast(`抓取完成: +${r.added} 条`); loadItems(); loadStatus() }
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
  const btn = $('#btnDigestRun')
  btn.disabled = true; btn.hidden = true // 生成中隐藏入口，防重入
  $('#btnDigestStop').hidden = false
  $('#digestBusy').hidden = false
  $('#statusbar').textContent = '生成日报中（LLM 总结可能要 1-2 分钟）…' // 直写状态栏：不被 toast 的 3s 自动刷新冲掉
  try {
    // force: 手动点 = 现在就要重新生成，含当日已推条目（幂等空跑由 force 绕过）
    const r = await post('/digest-run', { force: true })
    const doc = r.doc || {}
    const tk = doc.tokens ? ` · ${doc.tokens.inputTokens + doc.tokens.outputTokens} tokens` : ''
    toast(`日报已生成（${doc.itemCount ?? '?'} 条${doc.degraded ? ' · 总结降级' : ''}${tk}）`)
    loadDigest()
  } catch (e) { toast(`生成失败: ${e.message}`) }
  finally { btn.disabled = false; btn.hidden = false; $('#btnDigestStop').hidden = true; $('#digestBusy').hidden = true }
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
  $('#srcList').innerHTML = state.sources.map((s) => `
    <div class="src-wrap">
    <div class="src ${s.enabled ? '' : 'off'}">
      <div class="src-info">
        <b>${esc(s.title)}</b> <span class="tag">${esc(s.category)}</span>${s.builtin ? '<span class="tag dim">内置</span>' : ''}
        <div class="src-url">${esc(s.url)}</div>
        ${s.health?.lastError ? `<div class="src-err">✗ ${esc(s.health.lastError)}${s.health.cooldownUntil ? ' · 冷却中' : ''}</div>` : `<div class="src-ok">✓ ${s.health?.ok || 0} 次成功${s.health?.avgMs ? ` · ${Math.round(s.health.avgMs)}ms` : ''}</div>`}
      </div>
      <div class="src-actions">
        <button data-src-act="retry" data-id="${esc(s.url)}" title="立即抓取该源（冷却源则复活重试）">↻ 重试</button>
        <button data-src-act="toggle" data-id="${esc(s.url)}" data-en="${s.enabled ? 0 : 1}">${s.enabled ? '停用' : '启用'}</button>
        <button data-src-act="sum" data-id="${esc(s.url)}" data-sum="${s.summarize !== false ? 0 : 1}" title="该源条目是否生成 AI 摘要">${s.summarize !== false ? '摘要✓' : '摘要✗'}</button>
        <button data-src-act="edit" data-id="${esc(s.url)}" title="编辑源属性">⚙</button>
        ${s.builtin ? '' : `<button data-src-act="del" data-id="${esc(s.url)}">删除</button>`}
      </div>
    </div>
    ${state.editing === s.id ? `
    <div class="src-edit">
      <label class="wide">URL <input data-f="url" value="${esc(s.url)}"></label>
      <label>名称 <input data-f="title" value="${esc(s.title)}"></label>
      <label>分类 <input data-f="category" value="${esc(s.category)}"></label>
      <label><input type="checkbox" data-f="enabled" ${s.enabled ? 'checked' : ''}> 启用</label>
      <label><input type="checkbox" data-f="summarize" ${s.summarize !== false ? 'checked' : ''}> AI 摘要</label>
      <label><input type="checkbox" data-f="useProxy" ${s.proxy === true || typeof s.proxy === 'string' ? 'checked' : ''}> 使用代理</label>
      <label>最小冷却小时 <input type="number" min="0" step="1" data-f="cooldownHours" value="${s.cooldownHours ?? ''}" placeholder="24"></label>
      <button data-src-act="save" data-id="${esc(s.url)}">保存</button>
      <button data-src-act="cancel">取消</button>
    </div>` : ''}
    </div>`).join('')
}

$('#srcList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-src-act]')
  if (!btn) return
  const id = encodeURIComponent(btn.dataset.id)
  try {
    if (btn.dataset.srcAct === 'toggle') {
      await api(`/sources/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: btn.dataset.en === '1' }) })
    } else if (btn.dataset.srcAct === 'retry') {
      await api(`/sources/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'retry' }) })
      toast('已清除冷却，下次抓取重试该源')
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
        category: g('category').value.trim() || undefined,
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
    await post('/sources', { url, title: $('#newSrcTitle').value.trim() || undefined, category: $('#newSrcCat').value || undefined })
    $('#newSrcUrl').value = ''; $('#newSrcTitle').value = ''
    toast('已添加'); loadSources()
  } catch (e) { toast(`添加失败: ${e.message}`) }
})

$('#btnOpmlExport').addEventListener('click', () => {
  window.open(`${API}/opml`, '_blank')
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
  } catch { /* ignore */ }
}
$('#btnProxySave').addEventListener('click', async () => {
  try {
    await post('/prefs', { proxyUrl: $('#proxyUrl').value.trim() || undefined })
    toast('全局代理已保存，下次抓取生效')
  } catch (e) { toast(`保存失败: ${e.message}`) }
})

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
  } catch (e) { $('#llmInfo').textContent = `模型信息不可用: ${esc(e.message)}` }
}

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
  const b = document.createElement('button')
  if (isFirst) { b.textContent = '＋'; b.title = '新增时刻'; b.onclick = () => row.parentElement.appendChild(timeRow('', false)) }
  else { b.textContent = '−'; b.title = '删除该时刻'; b.onclick = () => row.remove() }
  row.append(inp, b)
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
    $('#schedInfo').textContent = `生效来源: ${r.effective === 'ui' ? '界面指定' : '配置默认'}；同一时刻若两表都含，先抓取后生成日报`
  } catch (e) { $('#schedInfo').textContent = `调度信息不可用: ${esc(e.message)}` }
}

$('#btnSchedSave').addEventListener('click', async () => {
  const digestTimes = collectTimes('#schedDigestRows')
  const fetchTimes = collectTimes('#schedFetchRows')
  await post('/schedule', { digestTimes, fetchTimes })
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

loadStatus(); loadSources().then(loadItems)
setInterval(loadStatus, 2000) // 未读计数 2s 轮询
