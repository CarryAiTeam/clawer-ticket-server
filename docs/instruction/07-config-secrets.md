# 07 · 配置与密钥

> 源码：[ones-config.ts](../../src/providers/ones/ones-config.ts)。

配置文件由 `CLAWER_TICKET_CONFIG_PATH` 指定；`ONES_MCP_CONFIG_PATH` 仍可作为已有部署的路径别名。MCP 参数永远不能提供凭据、host、team 或 provider。

## Profile 字段

- `provider: "ones"`、`source: "graphql" | "browser"`、`product: "project"`。
- `baseUrl`、`teamId`、非空 `allowedHosts` 和可选 `allowedProjects`。
- GraphQL profile 的 `secretRef`、可选认证头设置和请求预算。
- `inlineMaxChars` 与可选分类规则。
- browser profile 的可选 `executablePath` 和本机 `autoLogin`（邮箱、密码、可选 `loginUrl`）。

`baseUrl` 和可选 `loginUrl` 的 host 必须在 `allowedHosts`。生产配置应使用非空 `allowedProjects`；它既参与 provider 内部范围收窄，也被应用层检查返回项。

## 凭据规则

- GraphQL profile 需要 `secretRef`，其值是启动进程环境中密钥的引用名称。
- JSON 配置严格拒绝 `token` 等未声明字段。
- Browser profile 不需要 `secretRef`；`autoLogin` 只能存放在受 Git 忽略的本机配置中。
- 密码、Cookie、CSRF、原始响应和临时附件 URL 不会写入 bundle、MCP 响应或任务证据。

## 删除的旧配置

V1 不做兼容。以下字段已从 schema、样例和 browser 实现中删除，旧配置会被拒绝：

- `defaultView`
- `listAssigneeFieldId`
- `browser.myOpenViewUrl`

可用模板位于 [config](../../config)。
