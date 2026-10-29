// 新人引导步骤——改版引导时 bump ONBOARD_KEY 触发老用户重看
const ONBOARD_KEY = 'rss_onboarded_v1'
const ONBOARD_STEPS = [
  {
    title: '感谢你成为早鸟用户 🐣',
    bodyHtml: '这个插件还处于开发早期，界面还比较粗糙，功能也在持续迭代。看到 GitHub 和 npm 上的下载量，发现不少朋友第一时间就安装了它。为了让大家能尽快用起来，我连夜把核心功能开发完毕并上线了。<br><br>如果您在使用中遇到问题，或有什么想法和建议，欢迎来 GitHub 一起讨论：<br><a href="https://github.com/terry2010/dsh-rss-news-daily" target="_blank" rel="noopener">https://github.com/terry2010/dsh-rss-news-daily</a><br><br>每一条反馈，我都会认真观看。',
  },
  {
    title: '它每天替你总结重要新闻',
    body: '插件会自动抓取你订阅的新闻源，每天定时用 AI 挑出值得看的，按时整理成一份精选日报。你只要打开「今日精选」就能看当天的重点',
  },
  {
    title: '「全部新闻」随手翻',
    body: '所有抓到的新闻都在这里：可以搜索、按分类挑、只看没读过的。点新闻标题就能读全文',
  },
  {
    title: '每天一份精选，随时看热点',
    body: '「今日精选」里是当天的新闻总结和重点推荐；「时段快报」随时刷新当天的最新热点——省时间看这个就够了。',
  },
  {
    title: '三分钟让它更懂你',
    bodyHtml: '① 设置里勾选你关心的新闻分类<br>② 定好每天生成精选的时间<br>③ 遇到喜欢/不喜欢的随手点个 👍 / 👎，它会越推越准<br><br>其他默认就很好用，以后想调再说。',
  },
]
