# 15 · 用例

## 我的待办

```json
{ "preset": "my_open" }
```

语义是当前用户负责且状态类型不包含 `done`。不需要专用“我的待办”工具。

## 我的活跃工单

```json
{
  "preset": "my_active",
  "where": {
    "all": [
      { "field": "title", "op": "contains", "value": "111" },
      { "field": "issueType", "op": "in", "values": ["<stable-issue-type-id>"] }
    ]
  }
}
```

语义是负责人为当前用户，状态类型为未开始或进行中，同时进一步收窄标题和工作项类型。

## 查询导出

1. 用 `ticket_export({ query, mode:"plan" })` 查看完整选择和每张计划。
2. 审阅 selection。
3. 用同一 query 和 selection 调用 `ticket_export({ query, selection, mode:"write" })`。

若只需一张工单，传 `ticket:{ id }` 即可。若只需元数据，传 `media:"metadata"`。

## 延期能力

其他负责人、项目筛选、OR/嵌套条件、具体状态、排序、父子上下文和保存视图均不属于 V1。新增时扩展同一个 `ticket_search`，并先收集相应真实脱敏 ONES 请求证据，而不是添加新的专用 MCP 方法。
