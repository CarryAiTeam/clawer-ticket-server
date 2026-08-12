# 10 · 安全与脱敏

## 输入边界

- MCP 不接受任意 URL、header、cookie、GraphQL 文本、ONES `filterGroup`、内部 `after` 或动态字段 ID。
- `ticket_search` 只接受冻结的预设和一层受控 AND 条件。
- provider、host、team、项目范围和凭据均来自本地受控 profile。

## 网络与浏览器

- 所有 ONES endpoint、附件解析 URL 和 browser 登录 URL 的 host 都必须属于 `allowedHosts`。
- 浏览器使用新建的内存 context；不读取、导出或持久化用户现有 Chrome Cookie。
- MFA、CAPTCHA、SSO 和其他人工挑战不会被绕过。

## 数据输出

- `redactTicket` 会移除配置指定的自定义字段、临时附件 URL，以及在 `omitPeople:true` 时的人员信息。
- `redactTicketSummary` 对搜索摘要应用相同的人员脱敏，避免负责人由列表路径泄露。
- 附件二进制不进入 MCP 响应；临时下载 URL 只在当前请求内存中短暂存在。
- 导出前先通过 `getTicket`，因此 bundle 使用脱敏后的规范工单。

旧的 `browser.myOpenViewUrl` 与树形视图配置已经删除，不构成运行时安全边界。
