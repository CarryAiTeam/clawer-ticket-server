# 稳定错误恢复

仅在 MCP 返回错误码或需要解释恢复步骤时读取。完成普通错误路径后，仍执行主流程的临时浏览器清理规则。

| 结果 | 处理 |
| --- | --- |
| `PROFILE_REQUIRED` / `PROFILE_NOT_FOUND` | 请用户选择或更正 profile；不按候选顺序猜测。 |
| `SOURCE_UNAUTHORIZED` / `HUMAN_ACTION_REQUIRED` 且 connector 为 browser | 自动检查状态、连接并尝试 autoLogin；成功后重试原始只读调用一次，不要求“连接 ONES”确认。 |
| `AUTHORIZATION_PENDING` | 自动登录已提交但会话仍在结算；保持页面，短暂等待后只重试原目标工具一次。不要要求用户登录或声称 MFA、CAPTCHA、SSO。 |
| `HUMAN_ACTION_REQUIRED` 且 `details.authorizationState` 为 `manual-action-required` | 保留可见页面，说明需要完成的实际 ONES 操作；完成后检查状态并重试，不猜测挑战类型。 |
| 非 browser 的授权失败 | 说明实际可完成的授权操作；不伪造 browser 流程。 |
| `SOURCE_NOT_ALLOWED` | 保持当前范围并说明项目不在 allowlist；不要改成更宽或不同的项目查询。 |
| `QUERY_INVALID` / `UNSUPPORTED_FILTER` | 用受控 `scope`、`state`、`where` 重构；冲突意图才请用户澄清。 |
| `QUERY_CURSOR_INVALID` | 从原始查询第一页重新开始。 |
| `SELECTION_CHANGED` | 重新 plan 并展示变化后的范围；不要静默写入新选择。 |
| `EXPORT_CONFIRMATION_REQUIRED` | 这不是下载成功。展示冻结数量并等待明确确认；再以完全相同的 query、media 和 details 中的 selection 调用一次。 |
| `EXPORT_LIMIT_EXCEEDED` | 缩小范围或分批。 |
| `SOURCE_RATE_LIMITED` / `SOURCE_FAILED` / `SOURCE_SCHEMA_CHANGED` | 不重复造成压力的相同调用；简洁报告来源异常及可重试条件。 |
