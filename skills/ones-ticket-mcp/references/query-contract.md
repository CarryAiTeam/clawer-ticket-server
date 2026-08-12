# 查询与详情契约

仅在构造查询、处理分页、解析工单引用或处理项目范围时读取。以 MCP 当前 input schema 为最终事实来源。

## 查询形状

列表使用 `ticket_search({ profile?, scope, state, where?, page? })`。服务端固定按 `createTime DESC` 返回扁平摘要。

```json
{
  "scope": "self",
  "state": "all",
  "where": {
    "all": [
      { "field": "title", "op": "contains", "value": "登录" },
      { "field": "issueType", "op": "in", "values": ["<stable-issue-type-id>"] }
    ]
  },
  "page": { "size": 20 }
}
```

- `where.all` 只有一层 AND，最多 16 个条件；可用 `title contains`、稳定 `issueType` ID 和受控 `statusCategory` 的 `in`/`notIn`。
- 同一查询只允许一个标题条件。没有稳定 ID 时不要把展示名称猜成 `issueType` ID。
- 不传 token、Cookie、原始 ONES GraphQL、`filterGroup`、view URL、ONES `after`、OR/嵌套组、调用方排序或任意负责人字段。
- `scope: "self"` 表达当前负责人；`scope: "project"` 不额外传 `assignee`。

## 项目范围与分页

- 执行项目范围查询前，用 `ticket_connection_status` 确认选定 profile 的 `allowedProjects` 非空；空白名单会被拒绝为 `SOURCE_NOT_ALLOWED`。
- 第一页返回 `page.nextCursor` 时，续页复制相同 profile、scope、state、where、`page.size`，只把该 token 放入 `page.cursor`。
- cursor 是服务端 opaque token，不编辑、拼接、跨 profile/查询/页大小复用，也不替换成 ONES `after`。
- `QUERY_CURSOR_INVALID` 时，用原始查询从第一页重新开始，不重试失效 cursor。

## 详情和纯数字工单号

详情调用为 `ticket_get({ profile?, ticket: { id } })`。优先使用列表返回的内部 `id`。

用户给出纯数字工单号（如 `209488`）时，不要直接当成内部 `id`：先用当前范围和状态执行 `ticket_search`，逐页对返回项的 `number` 精确匹配；找到后才以该项内部 `id` 调用 `ticket_get`。全部页都无匹配时报告未找到，不要求用户提供内部 ID。
