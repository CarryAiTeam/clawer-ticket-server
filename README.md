# Clawer Ticket MCP

面向 ONES Project 的受控工单 MCP，提供扁平摘要搜索、单项详情和显式本地导出。

## V1 工具面

本项目提供以下 6 个工具：

| 工具 | 用途 |
| --- | --- |
| \`ticket_browser_connect\` | 为 browser profile 打开临时、可见的 Chrome 会话。 |
| \`ticket_browser_disconnect\` | 关闭临时浏览器并丢弃内存登录态。 |
| \`ticket_connection_status\` | 对 profile 执行小型只读授权探测。 |
| \`ticket_search\` | 只读搜索扁平工单摘要。 |
| \`ticket_get\` | 只读读取一张工单的有界详情、评论和附件元数据。 |
| \`ticket_export\` | 计划或显式写入完整工单 bundle，并按确认下载媒体。 |

## Codex Skill

项目工作区提供 `.agents/skills/ones-ticket-mcp/SKILL.md`。当在支持项目级 Skill 的 Codex 工作区中查询、读取、分页或导出 ONES 工单时，它会把中文表达归一化为范围与状态参数，并在导出写入前保留确认步骤。

对于 browser profile，用户的读取请求或导出 `plan` 请求即视为自动连接授权：如果首次只读调用发现会话未就绪，Skill 会直接打开临时浏览器、执行已配置的 `browser.autoLogin` 并重试原始调用，不要求额外回复“连接 ONES”。请求完成后会自动关闭该临时 ONES 页面并丢弃内存登录态，不要求再确认关闭。只有 ONES 实际显示 MFA、验证码、SSO 或其他人工挑战时，才需要在可见窗口操作；本规则不取消导出 `write` 的本地写入确认。

该 Skill 为调用方提供参数构造与流程引导，不替代服务端的 schema、项目白名单、cursor 或 selection 校验；它也不会随 npm 包一起安装到其他工作区。

## 三类中文意图

- “查看、查阅、查询、列出、获取 ONES 工单”只调用 `ticket_search`，默认是当前用户负责且未完成的列表。
- “查看详情、查阅某工单详情、获取某工单详情”调用 `ticket_get`，不落盘、不下载二进制媒体。
- “下载到本地、导出、保存到本地、获取到本地”调用 `ticket_export`，按 `plan → 确认 → write` 获取完整详情、评论和关联图片/附件。
- 用户给出 `209488` 这类纯数字工单号时，Skill 会先自动搜索并精确匹配 `number`，再用服务端返回的内部 `id` 读取详情。

“到本地/下载/导出/保存”优先级高于“查看/获取”；裸“获取”不会触发本地写入。

## 搜索

`ticket_search` 固定按 `createTime DESC` 返回摘要。它使用两个正交参数和一层受控 AND 筛选：

- `scope`：`self`（默认，负责人包含当前用户）或 `project`（仅在明确请求所有人/整个项目时使用）。
- `state`：`open`（默认，状态类型不包含 `done`）、`active`、`done` 或 `all`（包含已完成）。
- 筛选字段包括标题包含、工作项类型稳定 ID 和状态类型 `in/notIn`；`scope: "self"` 由服务端自动加入当前负责人条件。

因此“获取 ONES 工单”“获取我的待办”“获取我未完成的工单”均为 `scope: "self", state: "open"`；“获取所有 ONES”“获取 ONES 所有工单”均为 `scope: "self", state: "all"`。只有“所有人的、全员、整个项目”等明确范围词才使用 `scope: "project"`。

示例：

\`\`\`json
{
  "scope": "self",
  "state": "all",
  "where": {
    "all": [
      { "field": "title", "op": "contains", "value": "111" },
      { "field": "issueType", "op": "in", "values": ["<stable-issue-type-id>"] }
    ]
  },
  "page": { "size": 20 }
}
\`\`\`

响应中的 `page.nextCursor` 是服务端签发、内存保存的 opaque token。续页使用该 cursor，并保持相同 profile、scope、state、筛选和页大小；ONES 的 `after`、原始 GraphQL、`filterGroup`、view URL、项目筛选、其他负责人、OR/嵌套组和自定义排序均不属于公开输入面。

## 查询导出

单张导出传 `ticket`；查询导出传与 `ticket_search` 相同的 `query`（query 不含 `page`）。

1. 调用 \`ticket_export({ query, mode: "plan" })\`。
2. 审阅返回的 \`selection\` 与计划。
3. 将完全相同的查询和 \`selection\` 回传给 \`mode: "write"\`。

写入前会重新完整枚举查询结果；数量或有序 ID 集合变化时返回 \`SELECTION_CHANGED\`。计划阶段会逐张读取详情但不写本地；确认后的 write 也逐张读取、逐张原子写入，不会把全部详情保留在内存中。默认 \`media: "download"\`，显式 \`media: "metadata"\` 时不下载二进制附件。

服务端默认限制查询导出最多 50 张工单、500 个媒体文件、单文件 50 MiB、总媒体 512 MiB。可在 `storage.exportLimits` 中调整；超限返回 `EXPORT_LIMIT_EXCEEDED`。查询 write 会逐张处理并返回 `complete`、`completedCount` 和 `failedTickets`，重新 plan 后可利用已有 bundle 的幂等复用继续执行。

## 配置与安全

从 \`config/\` 复制浏览器或 GraphQL 示例到受 Git 忽略的本机位置，并通过 \`CLAWER_TICKET_CONFIG_PATH\` 指向它。

- GraphQL profile 使用 \`secretRef\` 从启动进程环境读取只读凭据；JSON 和工具参数都不能包含 token。
- Browser profile 可选 \`browser.executablePath\` 和本机 \`browser.autoLogin\`。MFA、验证码、SSO 和其他人工挑战必须在可见窗口中完成。
- \`allowedProjects\` 是受控范围；项目范围查询要求非空白名单，应用层和 ONES adapter 都会校验返回项；空白名单会返回 \`SOURCE_NOT_ALLOWED\`。
- 临时附件 URL、浏览器 Cookie 和原始 ONES 响应不会持久化或作为 MCP 响应返回。

## 开发与验证

常用命令：

\`\`\`bash
npm run build
npm test
\`\`\`

当前设计依据、真实脱敏 ONES 请求 fixture、分页证据和实施记录见 [ticket-tool-surface-design](./.cloudpivot-cli/task-runs/ticket-tool-surface-design/v1-requirements-and-delivery-plan.md)。
