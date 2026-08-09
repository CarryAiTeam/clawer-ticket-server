# 01 · 架构

> 本文描述当前 V1 源码，不保留旧树形待办或 wrapper 架构。

## 依赖方向

\`\`\`text
delivery/mcp
  → modules/tickets/application
    → modules/tickets/domain
    ← providers/ones
    ← modules/tickets/infrastructure/export
    ← infrastructure/http and infrastructure/security
bootstrap/create-server
  → 组合以上实现
\`\`\`

- Delivery 只做 MCP schema、错误投影和结果序列化。
- Application 编排 profile、查询规范化、分页 cursor、范围校验、详情读取与导出。
- Domain 定义 provider-neutral 的工单、搜索、错误和端口。
- ONES provider 只接收已规范化的领域查询，再编译为内部 GraphQL variables。
- Local bundle store 只处理本地原子写入和媒体恢复。
- Bootstrap 是唯一知道具体 ONES 实现和本地存储实现的位置。

## 主要数据流

### 搜索

\`\`\`text
ticket_search input
  → normalizeTicketSearchInput
  → profile + query fingerprint + optional opaque cursor
  → TicketProvider.search
  → provider page validation + allowedProjects final check + redaction
  → TicketSearchResult
\`\`\`

搜索结果是扁平 \`TicketSummary[]\`。外部不会看到 ONES \`pageInfo.endCursor\`、\`startPos\`、\`endPos\` 或 \`after\`。

### 查询导出

\`\`\`text
ticket_export(query, plan)
  → complete page enumeration
  → selection fingerprint
  → load every selected detail
  → plans

ticket_export(query, write, selection)
  → repeat enumeration + verify selection
  → load every selected detail
  → one atomic local export session per ticket
\`\`\`

若分页不完整、总数变化、ID 重复、项目越界、selection 变化或任一详情读取失败，服务在相应闸门处拒绝；详情读取失败时不会启动任何写入会话。

## Browser 与 GraphQL

\`OnesBrowserSource\` 继承 \`OnesGraphqlSource\`，仅将认证请求和附件下载替换为同源 browser fetch，并实现临时会话管理。两者共享同一个平铺 \`search\` 语义；浏览器不再提供页面 reconciliation、保存视图或树形读取。
