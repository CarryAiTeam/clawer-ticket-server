---
name: ones-ticket-mcp
description: 当用户获取、查询、查看列表、读取详情、分页、检查授权、连接或关闭 ONES 浏览器、导出 ONES 工单时使用；支持自动授权、自动清理和三工位补位下载。
---

# ONES 工单自动化

以 MCP 实际 schema 与返回值为准；不暴露 token、Cookie、原始 GraphQL 或临时 URL。

## 工具与路由

可用工具：`mcp__clawer_ticket__ticket_browser_connect`、`mcp__clawer_ticket__ticket_browser_disconnect`、`mcp__clawer_ticket__ticket_connection_status`、`mcp__clawer_ticket__ticket_search`、`mcp__clawer_ticket__ticket_get`、`mcp__clawer_ticket__ticket_export`。

| 请求意图 | 首选调用 | 关键规则 |
| --- | --- | --- |
| 查看、查阅、查询、列出工单 | `ticket_search` | 只读列表；默认 `scope: "self"`、`state: "open"` |
| 查看/读取某工单详情 | `ticket_get` | 只读详情、评论与附件元数据，不落盘 |
| 获取、下载到本地、导出、保存 | `ticket_export` | 默认完整副本：`mode: "write", media: "download"`；仅明确预览才用 `mode: "plan"`，仅明确不要媒体才用 `media: "metadata"` |

## 固定执行顺序

`normalize profile/ref → execute intended call → service auth recovery once when needed → render result`

Compatibility lifecycle notation: `normalize profile/ref → execute intended call → auth recovery once → retry once → disconnect in finally → render result`. The service now owns the automatic retry and cleanup, so callers must not repeat those tool calls.

1. 先直接调用目标工具；不要为普通读取、导出计划或本地下载预先调用连接或状态检查，也不要求回复“连接 ONES”。
   明确“获取、下载到本地、导出、保存到本地”本身也是一次写入授权。
2. browser profile 首次遇到 `SOURCE_UNAUTHORIZED` 或 `HUMAN_ACTION_REQUIRED` 时，服务端会自动打开浏览器、执行已配置的 `browser.autoLogin`，确认 `authentication.authorized: true` 后以原参数重试一次；无需二次确认。
3. 仅自动新建且已授权的临时会话会在成功、失败或取消时由服务端清理；显式 `ticket_browser_connect` 创建的会话不自动关闭。
4. 若出现 MFA、CAPTCHA、SSO 或其他人工挑战，服务端保留可见浏览器；请用户完成挑战后重试目标工具。不要重复打开浏览器，也不要自动关闭挑战页。
5. 用户明确要求连接、保持页面，或需要完成挑战时才调用 `ticket_browser_connect`；这类显式会话由调用方在完成后调用 `ticket_browser_disconnect`，不要求用户确认关闭。
6. `scope: "project"` 需要非空 `allowedProjects`；空白名单返回 `SOURCE_NOT_ALLOWED`，不得扩大范围。
7. 查询型 `write` 最多使用 3 个工位：每个工位只处理一张，完成详情读取、附件下载与原子落盘后立即领取下一张。不要并发调用多个 `ticket_export`。
8. 30 秒只是“仍在处理”的观察阈值，不是强制终止时间。取消时不领取下一张，已在处理的工单收尾后返回。

## 按需读取的参考契约

| 参考文件 | 读取条件 |
| --- | --- |
| [intent-mapping.md](references/intent-mapping.md) | 中文范围/状态、获取与只读边界无法直接判断时 |
| [query-contract.md](references/query-contract.md) | 构造 `where`、分页 cursor、数字工单号或项目白名单时 |
| [export-safety.md](references/export-safety.md) | 用户提出获取/下载/导出/保存，或需要执行 `plan → write` 时 |
| [errors.md](references/errors.md) | 需要解释 MCP 稳定错误码或恢复步骤时 |

返回时说明实际 profile、scope/state、选择数量、完成数量、失败项与 `completedTickets` 的完成顺序；导出还要明确是预览还是已写入。
