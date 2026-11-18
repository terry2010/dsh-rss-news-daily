---
name: release
description: dsh-rss-news-daily 发版全流程——确认版本与公告后 bump/commit/test/tag/push/npm publish/gh release，再从 npm 装回 desktop profile 验证
argument-hint: "<version>"
allowed-tools:
  - read
  - edit
  - exec
  - grep
  - glob
---

# 发版流程（dsh-rss-news-daily）

## 0. 硬规则（不可跳过）

- **版本号和发布内容必须先经用户确认**——changelog 条目、GitHub release notes、群公告文案，逐项确认后才允许 bump/commit/push/tag/release/npm publish。
- `git push` / `npm publish` 只在用户明确要求发版时执行。
- `git tag` 只在发布点创建；分支是 `master`。

## 1. 盘点未发布改动

```bash
git log --oneline v<上个版本>..HEAD
git diff v<上个版本>..HEAD --stat | grep -v 'lib/'   # lib/ 是构建产物，随 commit 入库
```

按主题归组（功能 / UI / 修复 / 安全加固 / docs），起草 changelog 条目——风格参考 web/changelog.js 既有条目：短句、用户视角、「重磅：」「修复：」前缀，docs 类改动一般不写。

- changelog 条目支持 `[文字](https://...)` markdown 链接——web/app.js 的 `linkify()` 先整串转义再换 `<a target="_blank" rel="noopener">`，目标白名单 http/https。升级弹层和设置区「更新公告」共用同一渲染。
- 版本号约定：有新功能 → minor（1.2.0）；纯修复 → patch。

## 2. bump + 构建 + 提交

```bash
# package.json version 改为新版本
npm run build   # tsc + copy-assets：web/ → lib/web/ 并给 index.html 资源打内容 hash
```

按"内容提交"先于"发版提交"分开 commit（风格参照 `git log`）：

```
fix(...)/feat(...): <改动说明>          # 普通改动 + 对应 lib/ 产物
release: X.Y.Z——<一句话概括主题>        # package.json + web/changelog.js + lib/web/*
```

- **lib/ 构建产物必须随 commit 提交**——`npm test` 内含 `git diff --exit-code lib`，lib 脏即失败。顺序：commit → npm test 全绿 → tag。
- commit 尾注：`Generated with [Devin](https://devin.ai)` + `Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>`。

## 3. 验证

```bash
npm test   # = build && git diff --exit-code lib && node --test test/*.test.mjs，必须全绿
```

## 4. tag → push → publish → GitHub release

```bash
git tag vX.Y.Z
git push origin master vX.Y.Z
npm publish
gh release create vX.Y.Z --title "X.Y.Z" --notes "<公告文案>"
```

- GitHub release notes 用 markdown，链接原生渲染。
- `web/changelog.js` 顶部同步为新版本条目（放在 release commit 里）。

## 5. 装回 desktop profile 验证——装 npm 发布产物，不是本地构建

```bash
# registry 传播需 1-5 分钟，先轮询
npm view dsh-rss-news-daily version   # 等到显示新版本
dsh plugin --profile desktop add dsh-rss-news-daily@X.Y.Z
```

- `dsh plugin` 是 pnpm 转发，这一步把 profile 依赖从 `file:<本地路径>` 切回 registry 版本号——验证的是用户真实拿到的产物。
- 下次开发再装本地构建：`node scripts/install-to-profile.mjs desktop`（会改回 `file:` 依赖）。
- 重启 dsh 生效；版本变化触发「已更新到 vX.Y.Z」升级弹层（localStorage `rss_seen_version` 判定）。设置区「更新公告」按钮可随时手工预览 CHANGELOG[0]。

## 6. 收尾

- 公告里引用的伴随插件仓（同目录 `../dsh-rss-news-*`）如有文档改动，一并 commit+push——链接要点得到。
- 回复用户：版本、tag、npm、release 链接、profile 验证方式。

## 常见坑

- `npm publish` 后 registry 有传播延迟——`npm view` 没刷到新版本前 `dsh plugin add` 装到的还是旧版。
- 升级弹层不自动弹：多半是版本没变或 `rss_seen_version` 已记录——用设置区「更新公告」按钮预览。
- `npm test` 挂在 `git diff --exit-code lib`：说明 lib/ 产物没提交，先 commit。
