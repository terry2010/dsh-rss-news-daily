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

        ctx.inject(['sidebarRightTabs', 'slots'], (scoped) => {
          try {
            const ReaderBody = () => h('iframe', {
              src: READER_URL,
              style: { width: '100%', height: '100%', border: 'none', background: 'transparent' },
              title: 'RSS 新闻',
            })
            const Title = () => h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
              h('span', { 'aria-hidden': 'true' }, '📰'), h('span', null, '新闻'))

            scoped.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: 'extension',
              title: () => '新闻',
              guide: [{
                id: TAB_KIND,
                kind: TAB_KIND,
                order: 60,
                title: () => 'RSS 新闻',
                description: () => '每日精选 · 全部条目 · 调教',
                icon: () => h('span', { style: { fontSize: 16 } }, '📰'),
              }],
            })
            scoped.slots.inject('sidebar.right.pane.tab', () =>
              scoped.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, ReaderBody))
            scoped.slots.inject('sidebar.right.pane.tab.title', () =>
              scoped.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, Title))
            log.info('sidebar tab registered')
          } catch (e) {
            log.warn(`sidebar tab failed (non-fatal): ${String(e)}`)
          }
        })

        // settings 卡：真实契约是 slots.register({name:'settings.plugins.tab'})，不是独立服务
        ctx.inject(['slots'], (scoped) => {
          try {
            const Card = () => h('div', { style: { padding: 12 } }, [
              h('h4', { key: 't' }, 'RSS 新闻日报'),
              h('p', { key: 'd', style: { color: '#888' } }, '每日精选（今日总结+N条）· 全量阅读器 · 偏好调教 · 不占用会话上下文'),
              h('a', { key: 'l', href: READER_URL, target: '_blank', rel: 'noopener' }, '打开阅读器 →'),
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
