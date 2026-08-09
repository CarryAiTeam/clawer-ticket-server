# Clawer Ticket MCP

面向 ONES Project 的受控工单 MCP。当前源码 V1 只提供扁平摘要搜索、单项详情和显式本地导出；不提供历史树形待办或其兼容 wrapper。

## V1 工具面

仅注册以下 6 个工具：

| 工具 | 用途 |
| --- | --- |
| \`ticket_browser_connect\` | 为 browser profile 打开临时、可见的 Chrome 会话。 |
| \`ticket_browser_disconnect\` | 关闭临时浏览器并丢弃内存登录态。 |
| \`ticket_connection_status\` | 对 profile 执行小型只读授权探测。 |
| \`ticket_search\` | 搜索扁平工单摘要。 |
| \`ticket_get\` | 读取一张工单的脱敏详情。 |
| \`ticket_export\` | 计划或显式写入单张工单、或完整冻结的搜索结果。 |

\`ticket_my_open_tasks\`、\`ticket_export_my_open_tasks\`、\`includeDetails\`、树形祖先结果和展示名称 \`statuses\` 均不是 V1 接口，也没有兼容入口。

## 搜索

\`ticket_search\` 固定按 \`createTime DESC\` 返回摘要。它只接受一个受控预设和一层 AND 筛选：

- \`my_open\`（默认）：负责人为当前用户，状态类型不包含 \`done\`。
- \`my_active\`：负责人为当前用户，状态类型为 \`to_do\` 或 \`in_progress\`。
- \`all\`：必须显式传入；仍受 profile 的 provider、host、team 与项目范围约束。
- 筛选字段仅为标题包含、工作项类型稳定 ID、状态类型 \`in/notIn\` 和 \`assignee in ["me"]\`。

示例：

\`\`\`json
{
  "preset": "my_active",
  "where": {
    "all": [
      { "field": "title", "op": "contains", "value": "111" },
      { "field": "issueType", "op": "in", "values": ["<stable-issue-type-id>"] }
    ]
  },
  "page": { "size": 20 }
}
\`\`\`

响应中的 \`page.nextCursor\` 是服务端签发、内存保存的 opaque token。续页必须保持相同 profile、预设、筛选和页大小；不能传 ONES 的 \`after\` 值。原始 GraphQL、\`filterGroup\`、view URL、项目筛选、其他负责人、OR/嵌套组、具体状态和自定义排序都会被拒绝。

## 查询导出

单张导出传 \`ticket\`；查询导出传与 \`ticket_search\` 相同的 \`query\`（但不允许 \`page\`）。

1. 调用 \`ticket_export({ query, mode: "plan" })\`。
2. 审阅返回的 \`selection\` 与计划。
3. 将完全相同的查询和 \`selection\` 回传给 \`mode: "write"\`。

写入前会重新完整枚举查询结果；数量或有序 ID 集合变化时返回 \`SELECTION_CHANGED\`。在任一详情读取失败前不会开始本地写入；每张工单的写入本身使用独立的原子导出会话。默认 \`media: "download"\`，显式 \`media: "metadata"\` 时不下载二进制附件。

## 配置与安全

从 \`config/\` 复制浏览器或 GraphQL 示例到受 Git 忽略的本机位置，并通过 \`CLAWER_TICKET_CONFIG_PATH\` 指向它。

- GraphQL profile 使用 \`secretRef\` 从启动进程环境读取只读凭据；JSON 和工具参数都不能包含 token。
- Browser profile 可选 \`browser.executablePath\` 和本机 \`browser.autoLogin\`。MFA、验证码、SSO 和其他人工挑战必须在可见窗口中完成。
- \`allowedProjects\` 是受控范围；应用层和 ONES adapter 都会校验返回项，生产配置应使用非空白名单。
- 临时附件 URL、浏览器 Cookie 和原始 ONES 响应不会持久化或作为 MCP 响应返回。

旧配置字段 \`defaultView\`、\`listAssigneeFieldId\` 和 \`browser.myOpenViewUrl\` 已删除；由于 V1 不做兼容，它们会被配置 schema 拒绝。

## 开发与验证

常用命令：

\`\`\`bash
npm run build
npm test
\`\`\`

当前设计依据、真实脱敏 ONES 请求 fixture、分页证据和实施记录见 [ticket-tool-surface-design](./.cloudpivot-cli/task-runs/ticket-tool-surface-design/v1-requirements-and-delivery-plan.md)。
