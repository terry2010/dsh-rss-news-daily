/**
 * 客户端半体：官方右侧栏 slot 挂「新闻」tab（iframe → /dsh-rss-news-daily/）
 * + settings 插件卡。全部包 try/catch——任何一步失败不得拖垮 dsh 启动。
 *
 * 运行时 env：React.createElement 可用（dock 同款）；slot 名：
 *   sidebarRightTabs.register({id,kind,priority,title,guide})
 *   slots.register({name:'sidebar.right.pane.tab',key},Component)
 */

const TAB_ID = 'rss-news-daily'
const TAB_KIND = 'rss-news'
const READER_URL = '/dsh-rss-news-daily/'

export const name = 'rss-news-daily'
export const inject = []

export function apply(ctx) {
  const log = (ctx && ctx.logger ? ctx.logger('rss-news-daily') : console)

  ctx.inject(['sidebarRightTabs', 'slots'], (scoped) => {
    try {
      const h = scoped.h || (globalThis.React && globalThis.React.createElement)
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

  ctx.inject(['settingsPlugins'], (scoped) => {
    try {
      scoped.settingsPlugins.register?.({
        id: TAB_ID,
        title: 'RSS 新闻日报',
        description: '每日精选（总结+N条）· 全量阅读器 · 偏好调教',
        order: 60,
      })
    } catch (e) {
      log.warn(`settings card failed (non-fatal): ${String(e)}`)
    }
  })
}
