// 新人引导步骤——改版引导时 bump ONBOARD_KEY 触发老用户重看
const ONBOARD_KEY = 'rss_onboarded_v1'
const ONBOARD_STEPS = [
  {
    title: '感谢你成为早鸟用户 🐣',
    bodyHtml: '这个插件还处于开发早期，界面还比较粗糙，功能也在持续迭代。看到 GitHub 和 npm 上的下载量，发现不少朋友第一时间就安装了它。为了让大家能尽快用起来，我连夜把核心功能开发完毕并上线了。<br><br>如果您在使用中遇到问题，或有什么想法和建议，欢迎来 GitHub 一起讨论：<br><a href="https://github.com/terry2010/dsh-rss-news-daily" target="_blank" rel="noopener">https://github.com/terry2010/dsh-rss-news-daily</a><br><br>每一条反馈，我都会认真观看。',
  },
  {
    title: '管线：抓取 → AI 评分 → 快报/日报',
    body: '插件按调度抓订阅源 → LLM 给每条打分 → 高分进时段快报(按小时累积) → 每天定点汇总日报。全部本地面板内完成,不进对话。',
  },
  {
    title: '全部新闻：阅读器',
    body: '按发布/抓取时间排序,搜索/分类/未读筛选,点标题即标已读。「抓取」可手动触发并实时显示进度,再点一次可取消。',
  },
  {
    title: '今日精选：日报与快报',
    body: '日报=每天定点生成的精选总览(总结/领域速览/重要新闻)；快报=每轮抓取后高分条目的时段增量,按 HH:mm 累积成天时间线。',
  },
  {
    title: '上手三件事',
    body: '① 设置里配模型路由(默认自动) ② 勾选订阅分类 ③ 定日报/抓取时刻。调教权重/屏蔽词也在设置,改即生效。',
  },
]
