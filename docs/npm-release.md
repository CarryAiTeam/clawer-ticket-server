# npm 发布流程

本项目通过 GitHub Actions 发布 `@carry-dream/clawer-ticket-server`。推送 `v<版本号>` Git tag 后，`.github/workflows/publish-npm.yml` 会从 npmjs 安装依赖、运行测试、校验 tag 与 `package.json` 的版本一致，并发布到 npmjs。

## 首次准备

1. 在 npmjs 创建或确认 `@carry-dream` 组织，并授予发布者权限。
2. 首次发布 `1.0.0` 后，在 npmjs 的包设置中为该包配置 GitHub Trusted Publisher：仓库为 `CarryAiTeam/clawer-ticket-server`，工作流为 `publish-npm.yml`。
3. GitHub Actions 通过 OIDC 获取短期发布身份，不需要保存长期 `NPM_TOKEN`。

## 发布步骤

1. 将 `package.json` 的版本更新为目标版本。
2. 运行 `npm test`。
3. 提交版本变更。
4. 创建并推送与版本完全一致的 Git tag，例如 `v1.0.1`。

工作流会拒绝 tag 名称和 `package.json` 版本不一致的发布。
