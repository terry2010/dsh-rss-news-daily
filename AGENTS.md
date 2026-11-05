# 项目规则

## 发版

- **每次发版前必须先和用户确认版本号和发布内容（changelog/欢迎页文案）**，用户确认后才允许 bump、commit、push、tag、release、npm publish。
- `git push` / `npm publish` 只在用户明确要求发版时执行。
- 发版完成后把 `web/changelog.js` 顶部同步为新版本条目，并安装到本地 desktop profile 验证。

## 验证

- `npm test`（tsc 构建 + copy-assets + node --test）必须全绿再提交。
- 本地安装：`node scripts/install-to-profile.mjs desktop`，重启 dsh 生效。
