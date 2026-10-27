/**
 * dsh-rss-news-daily client 半体（web）。
 *
 * 职责（M4 实现）：右侧栏「新闻」tab + 设置页卡片。
 * M0 为空壳：仅验证加载，所有可选服务一律 try/catch——
 * 客户端任何失败绝不允许拖垮宿主启动（kpeace 血泪注释）。
 */

export const name = 'rss-news-daily-client'

export function apply(ctx) {
  const log = (ctx && ctx.logger ? ctx.logger('rss-news-daily') : console)
  try {
    // M4: 轮询取 sidebar-right slot 服务 → registerTab({ title: '新闻', render: iframe→/dsh-rss-news-daily/ })
    // M4: settings.plugin.item keyed slot → 设置卡片（状态 + 打开阅读器按钮）
    log.info?.('client half loaded (reader tab lands in M4)')
  } catch (e) {
    try { log.warn?.('client init failed (non-fatal):', String(e && e.message || e)) } catch { /* 静默 */ }
  }
}
