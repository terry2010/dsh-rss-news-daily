# 项目规则

## 发版

- **每次发版前必须先和用户确认版本号和发布内容（changelog/欢迎页文案）**，用户确认后才允许 bump、commit、push、tag、release、npm publish。
- `git push` / `npm publish` 只在用户明确要求发版时执行。
- 发版完成后把 `web/changelog.js` 顶部同步为新版本条目，并**从 npm 装回发布产物**到本地 desktop profile 验证：`npm view` 确认 registry 已传播后 `dsh plugin --profile desktop add dsh-rss-news-daily@<版本>`（profile 依赖随之从 `file:` 切回 registry 版本号）。
- 完整流程见 `.devin/skills/release/SKILL.md`（`/release` 可调用）。

## 验证

- `npm test`（tsc 构建 + copy-assets + node --test）必须全绿再提交；内含 `git diff --exit-code lib`——lib/ 产物必须随 commit 入库。
- 本地开发安装：`node scripts/install-to-profile.mjs desktop`（装本地构建、依赖写为 `file:`），重启 dsh 生效。
