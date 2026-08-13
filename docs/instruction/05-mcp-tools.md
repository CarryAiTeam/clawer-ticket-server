# 05 · MCP 工具

> 源码：[ticket-server.ts](../../src/delivery/mcp/ticket-server.ts)。

服务只注册 6 个 `ticket_*` 工具。成功响应是 `{ ok: true, ... }`；领域错误响应是 `{ ok: false, error: { code, message } }`，并设置 `isError: true`。

## Profile 选择

所有工具均接受可选 `profile`。仅配置一个 profile 时可省略；多个 profile 时省略会返回 `PROFILE_REQUIRED`。provider、host、team 和项目范围只能来自本地受控配置。

## 会话与诊断

| 工具 | 用途 |
| --- | --- |
| `ticket_browser_connect` | 打开 browser profile 的独立可见 Chrome；可选执行受控邮箱/密码直登。 |
| `ticket_browser_disconnect` | 关闭临时浏览器，丢弃内存中的 CSRF 和登录态。 |
| `ticket_connection_status` | 对 profile 执行小型只读授权探测。 |

浏览器不会读取或导出用户原有 Chrome Cookie，不绕过 MFA、验证码或 SSO。未配置直登时从团队 workspace 入口打开，由用户在可见窗口完成登录。

## `ticket_search`

输入由 `profile?`、`preset?`、`where?` 和 `page?` 组成：

- `preset`：`my_open`（默认）、`my_active` 或显式 `all`。
- `where.all`：至多 16 个一层 AND 条件。
- 条件只允许标题 `contains`、工作项类型稳定 ID `in`、状态类型 `in/notIn`、负责人 `in ["me"]`。
- `page.size` 为 1..50；`page.cursor` 必须是上一响应的 `nextCursor`。

返回扁平摘要、规范化查询、精确 `totalCount`、`hasNextPage` 和可选 `nextCursor`。非法筛选、原始 ONES 字段、项目/其他负责人/OR/嵌套组等返回稳定 `QUERY_INVALID`。

## `ticket_get`

输入为 `{ profile?, ticket: { id } }`。返回脱敏且按内容预算裁剪的 `InlineTicket`。它读取一张详情、消息和附件 metadata，但不会下载二进制文件。

## `ticket_export`

输入要求 `ticket` 和 `query` 二选一；其余参数为可选 `profile`、`selection`、`mode` 和 `media`。

- 单张导出传 `ticket`。
- 查询导出传与 `ticket_search` 相同的 `query`，但不允许分页字段。
- 默认 `mode:"write"`，直接写入本机；只有显式 `mode:"plan"` 才是不写入的预览。
- 查询直接 `write` 在同一调用中冻结并写入当前选择；携带此前 `plan` 的 selection 时会校验该选择。
- “获取工单”应显式使用 `mode:"write", media:"download"`，得到附件与图片在内的完整本地副本；“查看、查阅、查询、列出”才使用只读工具。
- 默认 `media:"download"`；`metadata` 仅写入元数据和索引，只有明确要求不下载附件或图片时才使用。

查询写入会重新完整枚举；带 selection 的写入在选择变化时返回 `SELECTION_CHANGED`。服务在所有选中详情读取成功前不会启动任何写入会话。

## 明确不存在的接口

`ticket_my_open_tasks`、`ticket_export_my_open_tasks`、`includeDetails`、树形祖先行与命名状态 `statuses` 均不在 tools/list 中，也没有兼容 wrapper。
