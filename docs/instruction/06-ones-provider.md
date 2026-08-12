# 06 · ONES Provider

> 源码：[ones-graphql-source.ts](../../src/providers/ones/ones-graphql-source.ts) 与 [ones-browser-source.ts](../../src/providers/ones/ones-browser-source.ts)。

## 查询编译

应用层传入的 `TicketSearchQuery` 被编译为已验证的 ONES variables：

| 领域条件 | ONES filterGroup |
| --- | --- |
| 标题包含 | `name_match` |
| 工作项类型 ID | `issueType_in` |
| 状态类型包含 | `statusCategory_in` |
| 状态类型排除 | `statusCategory_notIn` |
| 负责人 `me` | `assign_in: ["$currentUser"]` |
| profile 项目范围 | 内部 `project_in`，仅由受控配置追加 |

排序固定为 `createTime DESC`。首次请求使用 `pagination: { limit, preciseCount:false }`；续页使用 `pagination: { limit, after }`。

真实脱敏请求 fixture 已被 ONES integration test 自动读取并比较，覆盖：

- `my_open` 的 `statusCategory_notIn:["done"] + assign_in:["$currentUser"]`；
- 标题、工作项类型、状态类型和当前负责人的平铺组合；
- 上一响应 `pageInfo.endCursor` 等于下一请求 `pagination.after`；
- `totalCount` 即使 `preciseCount:false` 或续页省略时仍可视为精确总数。

## 分页防御

adapter 将 ONES `pageInfo` 映射为 provider-neutral 页面，并在边界校验：

- `count` 是当前 `tasks` 数量；
- `totalCount` 为非负安全整数；
- `hasNextPage` 必须存在且为 boolean，缺失即 `SOURCE_SCHEMA_CHANGED`；
- `hasNextPage:true` 时 `endCursor` 必须是非空字符串。

应用层会再次校验页形状、项目范围和公共 cursor，因此 provider 响应不能被静默解释为“没有下一页”。

## Browser source

browser source 复用同一 `search` 实现，仅将认证请求和附件下载替换为同源 `fetch(..., { credentials:"include" })`。会话仅在当前 MCP 进程内存中保存。它不再提供页面 reconciliation、保存视图或树形读取。

## 项目字段边界

真实 UI “项目包含”样本使用租户动态字段 `_CFcrFX1y_in`。该字段没有作为公共 V1 filter 开放；其他项目筛选必须等待独立需求与跨配置证据。profile 白名单是服务端安全范围，不是调用方可传的 ONES 变量。
