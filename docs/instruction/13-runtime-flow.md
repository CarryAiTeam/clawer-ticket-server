# 13 · 运行流

## 搜索

```text
ticket_search
  → MCP schema（非法输入返回 QUERY_INVALID）
  → normalize preset + filters + page
  → profile / opaque cursor binding
  → ONES flat GraphQL search
  → pageInfo + allowedProjects validation
  → summary redaction
  → TicketSearchResult + optional nextCursor
```

内部映射为上一响应 `pageInfo.endCursor` → 下一 ONES 请求 `pagination.after`；原始 cursor 不离开应用层。

## 单项详情

```text
ticket_get
  → provider.getTicket
  → project allowlist validation
  → redactTicket
  → bounded InlineTicket
```

## 查询导出

```text
ticket_export(query, plan)
  → enumerate all pages → freeze selection → load all details → plans

ticket_export(query, write, selection)
  → enumerate again → verify selection → load all details → atomic writes
```

浏览器会话仅改变认证通道：browser source 与 GraphQL source 使用同一平铺搜索和详情语义，不存在树形视图或 reconciliation 分支。
