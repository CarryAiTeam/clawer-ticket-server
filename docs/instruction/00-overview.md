# 00 · 项目总览

\`clawer-ticket-server\` 是 ONES Project 的受控工单 MCP。当前 V1 只解决三件事：搜索扁平摘要、读取单项详情、将单项或冻结搜索结果导出到本机。

## 当前工具面

服务只注册 6 个工具：

1. \`ticket_browser_connect\`
2. \`ticket_browser_disconnect\`
3. \`ticket_connection_status\`
4. \`ticket_search\`
5. \`ticket_get\`
6. \`ticket_export\`

没有 \`ticket_my_open_tasks\`、\`ticket_export_my_open_tasks\`、\`includeDetails\`、树形祖先行、命名状态 \`statuses\` 或远程保存视图兼容面。

“我的待办”由 \`ticket_search({ preset: "my_open" })\` 表达；“我的活跃工单”由 \`my_active\` 表达；查询导出由 \`ticket_export({ query, mode })\` 表达。调用方负责将业务语言映射到公开的稳定参数，服务端负责校验、规范化、范围收窄与 ONES 编译。

## V1 边界

- 只支持一层 AND：标题包含、工作项类型稳定 ID、状态类型、负责人 \`me\`。
- 固定 \`createTime DESC\`，不公开排序。
- 公共 cursor 与 ONES \`after\` 隔离；服务端签发并绑定 profile、规范化查询与页大小。
- profile 固定 provider、host、team 和项目白名单；调用方不能扩大范围。
- 搜索只返回摘要；详情只能由 \`ticket_get\` 或导出内部读取。
- 导出先完整枚举、冻结 selection；写入前重新校验 selection，并在所有详情读取成功前不开始写盘。

## 分层

\`\`\`text
MCP tools
  → TicketApplication
    → TicketProvider / BrowserSessionProvider / TicketBundleStore
      → ONES GraphQL, browser session, local filesystem
\`\`\`

领域层不接收原始 ONES GraphQL，也不暴露 cookie、临时附件 URL 或 provider cursor。

## 代码导航

- [01-architecture.md](./01-architecture.md)：依赖方向和数据流。
- [02-domain-model.md](./02-domain-model.md)：搜索、摘要、详情和导出契约。
- [03-ports-interfaces.md](./03-ports-interfaces.md)：应用层端口。
- [04-application-service.md](./04-application-service.md)：用例与完整性闸门。
- [05-mcp-tools.md](./05-mcp-tools.md)：六个公开工具。
- [06-ones-provider.md](./06-ones-provider.md)：ONES 编译与分页。
- [07-config-secrets.md](./07-config-secrets.md)：配置、范围与凭据。

V1 的冻结需求和真实脱敏 ONES 证据以 [ticket-tool-surface-design](../../.cloudpivot-cli/task-runs/ticket-tool-surface-design/v1-requirements-and-delivery-plan.md) 为准。
