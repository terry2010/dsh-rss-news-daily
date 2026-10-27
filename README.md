# dsh-rss-news-daily

> DeepSeek Harness（dsh）插件：每天定时生成「**今日要闻总结 + 重要 N 条**」简报，右侧栏阅读器看全量，阅读习惯可调教——**全程不进会话、不占上下文**。

开发中（M0）。规格见 `docs/DESIGN.md`，计划见 `docs/PLAN.md`，源策略见 `docs/SOURCES.md`。

## 特性（设计）

- 📰 **日报 = 总结段 + 重要 N 条**：LLM 整段总述（概述/重点/趋势）+ 编号条目列表，`digestItems` 可配（默认 20，无隐藏硬顶）
- 📚 **右侧栏阅读器**：全量条目流、分类/搜索/已读/按天翻阅；浏览器直开 `/dsh-rss-news-daily/` 亦可
- 🎛 **可调教**：自然语言调教（"多推 AI 少推币圈"）+ 👍👎 反馈，权重落盘立即重排
- 🔌 **自定义源**：53 个内置源（本机实测可达背书）+ GUI/工具/OPML 增删，保存时抓取校验
- 🚫 **零上下文消耗**：不注入 systemPrompt、不发会话消息——只在面板里
- 🛡 **逐条降级**：LLM 失败只降级该条，日报永远产出

## 安装

```sh
dsh plugin --profile web add dsh-rss-news-daily   # npm 发布后
# 开发期（真实目录装进 profile，禁用 link:）：
node scripts/install-to-profile.mjs <profile名>
```

> ⚠️ **不要用 `link:` 安装**：pnpm link 会让 Node 按真实路径解析模块，插件目录内没有 node_modules 时 `@deepseek-ai/*` 全部解析失败（`dsh plugin add <本地路径>` 会产生 link:，用 `file:` 或本仓库的 install 脚本）。

## License

MIT
