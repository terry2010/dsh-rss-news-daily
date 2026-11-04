/**
 * 客户端半体（classic script！宿主经 window.__ModuleLoader__.load 加载，
 * 禁止 ESM export——SyntaxError 会拖垮同 combo 的全部插件）。
 *
 * 官方右侧栏 slot 挂「新闻」tab（iframe → /dsh-rss-news-daily/）+ settings 卡。
 * 全部包 try/catch——任何一步失败不得拖垮 dsh 启动。
 */
;(() => {
  'use strict'

  const TAB_ID = 'rss-news-daily'
  const TAB_KIND = 'rss-news'
  const READER_URL = '/dsh-rss-news-daily/'

  window.__ModuleLoader__.load({
    id: 'dsh-rss-news-daily',
    factory: (require) => {
      const React = require('react')
      const h = React.createElement

      const inject = ['slots', 'sidebarRightTabs']

      function apply(ctx) {
        const log = (ctx && ctx.logger ? ctx.logger('rss-news-daily') : console)

        // dsh-app:// 自定义协议下 iframe 内 fetch() 会被挂起；用 webServer 的
        // http://127.0.0.1:port 绝对地址作 src，让页面落在 http origin（fetch 同源放行）。
        let readerUrl = READER_URL
        ctx.inject(['webServer'], (scoped) => {
          try {
            const root = scoped.webServer && scoped.webServer.rootURL
            if (root) readerUrl = String(root).replace(/\/+$/, '') + READER_URL
          } catch (e) {
            log.warn(`webServer.rootURL unavailable, iframe stays on relative path: ${String(e)}`)
          }
        })

        // 左侧导航运行时显隐的共享句柄：panellist inject 与 settings 卡开关共用
        let toggleNav = null          // (show)=>void，slots 就绪后赋值
        let readNavPref = () => true  // 同步读 prefs.showNavEntry
        let layoutRef
        ctx.inject(['layout'], (s) => { try { layoutRef = s && s.layout } catch { /* 无 layout 服务则跳过反选 */ } })

        ctx.inject(['sidebarRightTabs', 'slots'], (scoped) => {
          try {
            // dsh 主题在 body[data-ds-dark-theme]；?theme= 管首屏，MutationObserver+postMessage 管切换
            const themeName = () => (document.body && document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light')
            const ReaderBody = () => {
              const ref = React.useRef(null)
              React.useEffect(() => {
                const push = () => {
                  try { ref.current && ref.current.contentWindow && ref.current.contentWindow.postMessage({ type: 'rnd-theme', theme: themeName() }, '*') } catch (e) { /* iframe 未就绪则下次 mutation 再推 */ }
                }
                push()
                const mo = new MutationObserver(push)
                if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
                return () => mo.disconnect()
              }, [])
              return h('iframe', {
                ref,
                src: `${readerUrl}?theme=${themeName()}`,
                style: { width: '100%', height: '100%', border: 'none', background: 'transparent' },
                title: '新闻精选',
              })
            }
            const Title = () => h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
              h('span', { 'aria-hidden': 'true' }, '📰'), h('span', null, '新闻精选'))

            // 工作区导航条目按偏好条件注册（设置页开关；fetch 失败=默认显示）
            const registerNav = (show) => {
              try {
                scoped.sidebarRightTabs.register({
                  id: TAB_ID,
                  kind: TAB_KIND,
                  priority: 'extension',
                  title: () => '新闻精选',
                  guide: show ? [{
                    id: TAB_KIND,
                    kind: TAB_KIND,
                    order: 60,
                    title: () => '新闻精选',
                    description: () => '每日精选 · 全部条目 · 调教',
                    icon: () => h('span', { style: { fontSize: 16 } }, '📰'),
                  }] : [],
                })
              } catch (e) { log.warn(`sidebarRightTabs.register failed: ${String(e)}`) }
            }
            // 同步读偏好决定显隐——注册必须在 inject 同步窗口内完成，异步 fetch 会被宿主丢弃
            const loadShowNav = () => {
              try { // node 集成可用时直读 prefs.json（最快且不依赖 webServer 就绪）
                const j = JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(), '.dsh', 'rss-news-daily', 'prefs.json'), 'utf8'))
                return j.showNavEntry !== false
              } catch { /* fs 不可用→退化同步 XHR */ }
              try {
                const xhr = new XMLHttpRequest()
                xhr.open('GET', `${readerUrl}api/prefs`, false)
                xhr.send(null)
                return (JSON.parse(xhr.responseText || '{}')?.prefs?.showNavEntry) !== false
              } catch { return true } // 读不到→默认显示
            }
            const NavIcon = (owner = {}) => h('svg', {
              width: owner.size ?? 16, height: owner.size ?? 16, viewBox: '0 0 16 16',
              fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
              'aria-hidden': 'true',
            },
              h('path', { d: 'M2.5 3.5h8.5v9H4a1.5 1.5 0 0 1-1.5-1.5v-7.5z' }),
              h('path', { d: 'M11 5.5h1.8a1 1 0 0 1 1 1V11a1.5 1.5 0 0 1-1.5 1.5H11' }),
              h('path', { d: 'M4.5 6h4M4.5 8.2h4M4.5 10.4h2.6' }))

            const showNav = loadShowNav()
            registerNav(showNav)
            // 左侧工作区导航（市场在用的契约）：sidebar.panellist 导航行 + main 主面板。
            // sidebarRightTabs.guide 是另一套，不是这个菜单。
            // slots.register 返回 disposer——配合 settings 卡的开关可运行时显隐。
            readNavPref = loadShowNav
            let navOff = null
            const slotsSvc = (ctx && ctx.slots) || scoped.slots // 与市场一致用 ctx.slots；scoped 包装可能吞 disposer
            toggleNav = (v) => {
              try {
                if (v && !navOff) {
                  const offPanel = slotsSvc.register({ name: 'main', key: TAB_ID }, ReaderBody)
                  const offRow = slotsSvc.register({ name: 'sidebar.panellist', id: TAB_ID, order: 60, label: () => '新闻精选' }, NavIcon)
                  navOff = () => {
                    try { if (typeof offRow === 'function') offRow() } catch { /* 宿主可能不给 disposer */ }
                    try { if (typeof offPanel === 'function') offPanel() } catch {}
                  }
                  log.info('workspace nav row registered')
                } else if (!v && navOff) {
                  // 先离开页面再注销面板：选中态指向已注销 key 会空悬（市场同款处理）
                  try { if (layoutRef?.panelInfo?.getSnapshot?.().activePanelId === TAB_ID) layoutRef.selectPanel(null) } catch {}
                  navOff(); navOff = null
                  log.info('workspace nav row unregistered')
                }
              } catch (e) { log.warn(`nav row toggle failed: ${String(e)}`) }
            }
            scoped.slots.inject('sidebar.panellist', () => { if (loadShowNav()) toggleNav(true) })
            scoped.slots.inject('sidebar.right.pane.tab', () =>
              scoped.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, ReaderBody))
            scoped.slots.inject('sidebar.right.pane.tab.title', () =>
              scoped.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, Title))
            // 会话 header 动作区（标题/「标准模式」右侧）：conversation.session.header.actions
            const NewsAction = () => h('button', {
              type: 'button',
              title: '打开 RSS 新闻阅读器',
              style: {
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 8px', borderRadius: 6, fontSize: 12, lineHeight: '18px',
                border: '1px solid var(--dsh-color-border, #d0d0d0)', background: 'transparent', cursor: 'pointer',
              },
              onClick: () => {
                try {
                  const sr = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined
                  if (sr && sr.openTab) sr.openTab(TAB_KIND)
                  else window.open(readerUrl, '_blank')
                } catch { window.open(readerUrl, '_blank') }
              },
            }, h('span', { 'aria-hidden': 'true' }, '📰'), h('span', null, '新闻'))
            scoped.slots.inject('conversation.session.header.actions', () =>
              scoped.slots.register({
                name: 'conversation.session.header.actions',
                id: 'rss-news-action',
                order: 30, // 跟在 preset label(≈0-10)/jobs(20) 之后
                label: () => '新闻',
              }, NewsAction))
            log.info('sidebar tab + conversation view registered')
          } catch (e) {
            log.warn(`sidebar tab failed (non-fatal): ${String(e)}`)
          }
        })

        // settings 卡：真实契约是 slots.register({name:'settings.plugins.tab'})，不是独立服务
        ctx.inject(['slots'], (scoped) => {
          try {
            const Card = () => h('div', { style: { padding: 12 } }, [
              h('h4', { key: 't' }, '新闻精选'),
              h('p', { key: 'd', style: { color: '#888' } }, '每日精选（今日总结+N条）· 全量阅读器 · 偏好调教 · 不占用会话上下文'),
              h('a', { key: 'l', href: READER_URL, target: '_blank', rel: 'noopener' }, '打开阅读器 →'),
              // 宿主上下文里的开关：直接调 toggleNav 即时显隐，同时落 prefs 保持重启后一致
              h('label', { key: 'nav', style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, cursor: 'pointer' } }, [
                h('input', {
                  key: 'cb', type: 'checkbox', defaultChecked: readNavPref(),
                  onChange: (e) => {
                    const v = e.target.checked
                    try { toggleNav && toggleNav(v) } catch (err) { log.warn(`nav toggle failed: ${String(err)}`) }
                    try { fetch(`${readerUrl}api/prefs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ showNavEntry: v }) }).catch(() => {}) } catch { /* 落盘失败不影响本次显隐 */ }
                  },
                }),
                '左侧导航显示入口（重启 dsh 后生效）',
              ]),
            ])
            scoped.slots.inject('settings.plugins.tab', () =>
              scoped.slots.register({ name: 'settings.plugins.tab', key: TAB_ID }, Card))
          } catch (e) {
            log.warn(`settings card failed (non-fatal): ${String(e)}`)
          }
        })
      }

      return { inject, apply }
    },
  })
})()
