---
name: ones-ticket-mcp
description: 当用户查询、查看列表、读取详情、分页、检查授权、连接或关闭 ONES 浏览器、导出 ONES 工单时使用；支持中文意图归一化、纯数字工单号自动解析、browser.autoLogin 自动授权和完成后自动清理临时页面。
---

# ONES 工单自动化流水线

将用户的一次请求完成为“连接/授权 → 读取 → 返回 → 关闭临时 ONES 页面”的完整流水线。以 MCP 实际 schema 和返回值为准，不向用户暴露 token、Cookie、原始 GraphQL 或临时 URL。

## 工具与路由

可用工具：`mcp__clawer_ticket__ticket_browser_connect`、`mcp__clawer_ticket__ticket_browser_disconnect`、`mcp__clawer_ticket__ticket_connection_status`、`mcp__clawer_ticket__ticket_search`、`mcp__clawer_ticket__ticket_get`、`mcp__clawer_ticket__ticket_export`。

| 请求意图 | 首选调用 | 关键规则 |
| --- | --- | --- |
| 查看、查阅、查询、列出、获取工单 | `ticket_search` | 只读列表；默认 `scope: "self"`、`state: "open"` |
| 查看/获取某工单详情 | `ticket_get` | 详情、评论流和附件元数据；纯数字工单号先精确搜索 `number` 再用内部 `id` |
| 下载到本地、导出、保存、获取到本地 | `ticket_export` | 明确下载即 `mode: "write"`；仅明确提出计划、预览或先看看导出范围时用 `mode: "plan"` |

## 固定执行顺序

对每次请求遵循：

`normalize profile/ref → execute intended call → auth recovery once → retry once → disconnect in finally → render result`

1. 规范化 `profile` 和工单引用。用户明确给出 profile 原样传入；只有服务确认恰好一个 profile 时才省略。profile 不明确时请用户选择，不猜测。
2. 不为普通只读、导出计划或明确本地下载请求预先询问连接授权或调用状态；先执行目标调用。明确“下载到本地、导出、保存到本地、获取到本地”本身也是一次写入授权，不要求回复“连接 ONES”或重复确认下载。
3. 目标调用返回 `SOURCE_UNAUTHORIZED` 或 `HUMAN_ACTION_REQUIRED` 时，调用 `ticket_connection_status`；connector 为 `browser` 就立即调用 `ticket_browser_connect`。它会按 `browser.autoLogin` 自动登录并探测 `authentication.authorized: true`，无需二次确认。
4. 自动授权成功后，用完全相同的参数重试原始只读调用一次。仍未授权时，仅在真实出现 MFA、CAPTCHA、SSO 或其他人工挑战时请用户在可见窗口完成；不绕过挑战。
5. `scope: "project"` 是必要的项目级例外：查询前确认 `allowedProjects` 非空；空白名单按 `SOURCE_NOT_ALLOWED` 停止，不扩大范围。
6. 在列表、详情、分页、导出 `plan` 或 `write` 到达终态后，在 `finally` 调用 `ticket_browser_disconnect` 清理本次使用的临时 browser session；成功、未找到和普通错误都清理。不要求用户确认关闭。
7. 若出现 MFA/CAPTCHA/SSO，或用户明确说“保持浏览器打开”，保留可见页面，直到挑战/后续请求完成；这是唯一的页面清理例外。

## 按需读取的参考契约

仅在对应分支需要时读取，避免把低频细节注入每次查询：

| 参考文件 | 读取条件 |
| --- | --- |
| [intent-mapping.md](references/intent-mapping.md) | 中文范围/状态、列表与详情边界、`self`/`project` 组合无法直接判断时 |
| [query-contract.md](references/query-contract.md) | 构造 `where`、分页 cursor、纯数字工单号查找或项目白名单参数时 |
| [export-safety.md](references/export-safety.md) | 用户提出下载/导出/保存，或需要执行 `plan → write` 时 |
| [errors.md](references/errors.md) | MCP 返回稳定错误码、恢复或向用户说明异常时 |

返回时说明实际 profile、scope/state、筛选、数量和是否还有下一页；导出要明确是预览计划还是已写入。
