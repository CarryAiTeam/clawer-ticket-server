# 11 · 错误处理

所有可预期业务错误使用 `TicketError`，MCP 返回稳定 `error.code`。

| 错误码 | 含义 |
| --- | --- |
| `PROFILE_NOT_FOUND` / `PROFILE_REQUIRED` | profile 不存在，或多 profile 时未选择。 |
| `CONFIG_INVALID` / `SECRET_UNAVAILABLE` | 本地配置或密钥不可用。 |
| `SOURCE_UNAUTHORIZED` / `HUMAN_ACTION_REQUIRED` | ONES 授权失败或需要用户完成浏览器登录。 |
| `SOURCE_RATE_LIMITED` | ONES 或本地预算要求等待/重试。 |
| `SOURCE_SCHEMA_CHANGED` | ONES 响应缺字段、字段类型错误或分页元数据不一致。 |
| `SOURCE_INCOMPLETE` | 查询无法完整枚举、总数变化或超过受控导出上限。 |
| `SOURCE_NOT_ALLOWED` | 返回项不在 profile 项目白名单内。 |
| `QUERY_INVALID` / `UNSUPPORTED_FILTER` | 公共查询不符合 V1 契约或 adapter 不支持该领域条件。 |
| `QUERY_CURSOR_INVALID` | cursor 被篡改、过期、跨 profile/查询/页大小复用。 |
| `SELECTION_CHANGED` | 查询导出的 plan 与 write 之间选择发生变化。 |

特别规则：缺失 `pageInfo.hasNextPage` 不能按 `false` 处理；有下一页却缺失 `endCursor` 不能继续；所有这些情况都必须 fail closed。
