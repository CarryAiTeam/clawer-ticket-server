# 05 · MCP 工具详细说明

> 源文件：[src/delivery/mcp/ticket-server.ts](../src/delivery/mcp/ticket-server.ts)。

服务名：`clawer-ticket-mcp`，版本 `1.0.0`。共注册 **7 个工具**，全部 `ticket_*` 前缀。所有工具的返回都是 `{ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError? }` 形式。

## 0. 通用约定

### 0.1 结果投影 `textResult`

```ts
function textResult(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}
```

- 成功：`{ ok: true, ...业务字段 }`。
- 失败：见下。

### 0.2 错误投影 `errorResult`

```ts
function errorResult(error: unknown) {
  if (error instanceof TicketError) return textResult({ ok: false, error: { code: error.code, message: error.message } }, true);
  return textResult({ ok: false, error: { code: "UNEXPECTED", message: error instanceof Error ? error.message : "Unexpected error" } }, true);
}
```

- `TicketError` → 稳定错误码（见 [11-error-handling.md](./11-error-handling.md)）。
- 其他异常 → `UNEXPECTED`，**不泄露未处理异常结构**。

### 0.3 annotations 约定

- `readOnlyHint`：是否只读。
- `destructiveHint`：是否破坏性（本项目所有工具都 `false`）。
- `openWorldHint`：是否访问外部世界（ONES / 浏览器）。

---

## 1. `ticket_browser_connect`

**标题**：Open supervised ONES browser session

**描述**：打开一个全新的可见 Chrome 窗口供该 browser profile 使用。配置了 `autoLogin` 时，提交本地直登凭据并立即执行只读 ONES 授权探针；结果明确报告会话是否就绪。MFA、CAPTCHA、SSO 确认等挑战始终需要用户操作。会话只存在于本 MCP 进程内，绝不导出或持久化。

**入参 schema**：
```ts
{ profile: z.string().min(1) }
```

**annotations**：`readOnlyHint: false, destructiveHint: false, openWorldHint: true`

**成功返回**：
```json
{
  "ok": true,
  "url": "<当前页面 URL>",
  "message": "<人类可读说明>",
  "authentication": {
    "mode": "auto" | "manual",
    "authorized": true | false,
    "diagnostics": ["..."]
  }
}
```

**行为细节**：
- 仅对 `source: "browser"` profile 可用；GraphQL profile 调用会抛 `CONFIG_INVALID`。
- `autoLogin` 配置时：导航到 `loginUrl` → 等待邮箱/密码输入框可见 → 填入 → 点提交 → 在 `[500,1000,2000,4000]` ms 的稀疏探测窗口内反复调 `status` 确认授权。
- 未配置 `autoLogin`：直接打开 `myOpenViewUrl` 或团队 workspace 入口，`authorized: false`，提示用户手动登录。
- 同时只能有一个 browser profile 激活；切换需先 `ticket_browser_disconnect`。
- 失败模式：
  - Chrome 未找到 → `HUMAN_ACTION_REQUIRED`。
  - 登录页 host 不在 allowlist → `HUMAN_ACTION_REQUIRED`。
  - 邮箱/密码/提交控件不可见 → `HUMAN_ACTION_REQUIRED`（MFA/验证码/SSO/自定义页面不自动化）。

---

## 2. `ticket_browser_disconnect`

**标题**：Close supervised ONES browser session

**描述**：关闭临时可见浏览器并丢弃其内存中的 ONES 会话。

**入参 schema**：
```ts
{ profile: z.string().min(1) }
```

**annotations**：`readOnlyHint: false, destructiveHint: false, openWorldHint: false`

**成功返回**：
```json
{ "ok": true, "closed": true }
```

**行为细节**：
- 关闭 browser / context / page。
- 清空 `csrfToken` / `activeProfileName` / `ticketCache`。
- 内存登录态立即丢弃；MCP 重启也会丢弃。

---

## 3. `ticket_connection_status`

**标题**：Ticket provider connection status

**描述**：检查所选 ticket-provider profile 并发起一次小型只读 ONES 授权探针。

**入参 schema**：
```ts
{ profile: z.string().min(1) }
```

**annotations**：`readOnlyHint: true, openWorldHint: false`

**成功返回**：
```json
{
  "ok": true,
  "profile": "<name>",
  "provider": "ones",
  "connector": "graphql" | "browser",
  "allowedProjects": ["..."],
  "configured": true,
  "authorized": true | false,
  "diagnostics": ["..."],
  "credentialAvailable": true | false
}
```

**行为细节**：
- GraphQL：`resolveToken` → `MY_OPEN_MATCHED_QUERY`（limit=1）探针。
  - `SECRET_UNAVAILABLE` → `credentialAvailable: false, authorized: false`。
  - 其他 `TicketError` → `credentialAvailable: true, authorized: false, diagnostics: ["online authorization probe failed: <code>"]`。
- Browser：若未开页面或激活 profile 不匹配 → `credentialAvailable: false, authorized: false`，提示先开浏览器会话；否则调 `super.listMyOpen(profile, 1)` 探针。

---

## 4. `ticket_my_open_tasks`

**标题**：My open ticket tasks with complete details

**描述**：读取当前用户、未完成的每张工作项及其完整 ONES 详情 bundle（描述、状态、负责人、优先级、迭代、评论和附件元数据）。父级行仅作为上下文报告，不作为工作项导出。

**入参 schema**：
```ts
{
  profile: z.string().min(1),
  limit: z.number().int().min(1).max(1_000).default(1_000),
  includeDetails: z.boolean().default(true)
}
```

**annotations**：`readOnlyHint: true, openWorldHint: true`

**成功返回（`includeDetails: true`，默认）**：
```json
{
  "ok": true,
  "view": "my_open_tree",
  "items": [ /* TicketIndexItem[] */ ],
  "roots": ["..."],
  "externalParentIds": ["..."],
  "page": { "count": N, "matchedCount": M, "contextCount": K, "totalCount": T, "hasNextPage": false },
  "tickets": [ /* CanonicalTicket[]（已脱敏） */ ],
  "detailCount": M,
  "complete": true
}
```

**成功返回（`includeDetails: false`）**：
```json
{
  "ok": true,
  "view": "my_open_tree",
  "items": [ ... ],
  "roots": [...],
  "externalParentIds": [...],
  "page": { ... }
}
```

**行为细节**：
- `includeDetails: true` 时调 `listMyOpenDetails`：三道安全闸（hasNextPage / matchedCount 校验 / 逐条详情），任一失败抛 `SOURCE_INCOMPLETE`。
- `includeDetails: false` 时只返回索引树。
- 父级上下文项（`matchedFilter: false`）不出现在 `tickets` 中。

---

## 5. `ticket_get`

**标题**：Get a ticket work item

**描述**：从所选 provider 读取一张工作项，含详情、消息流和附件元数据。

**入参 schema**：
```ts
{
  profile: z.string().min(1),
  ticket: z.object({ id: z.string().min(1).max(128) })
}
```

**annotations**：`readOnlyHint: true, openWorldHint: true`

**成功返回**：
```json
{
  "ok": true,
  "ticket": { /* InlineTicket（已脱敏 + 按预算裁剪） */ }
}
```

**行为细节**：
- 调 `getTicketInline` → `getTicket`（归一化 + 项目校验 + 脱敏）→ `projectTicketForInline` 按 `inlineMaxChars` 裁剪。
- `ticket.id` 是 ONES UUID（带不带 `task-` 前缀都行，`toTaskKey` 会规整）。
- 完整内容应使用 `ticket_export` 落盘；内联响应受字符预算限制。

---

## 6. `ticket_export`

**标题**：Export a ticket work item

**描述**：本地计划或写入一张规范化工单 bundle。Write 导出默认下载媒体；临时 ONES URL 永不返回或持久化。

**入参 schema**：
```ts
{
  profile: z.string().min(1),
  ticket: z.object({ id: z.string().min(1).max(128) }),
  mode: z.enum(["plan", "write"]).default("plan"),
  media: z.enum(["metadata", "download"]).default("download")
}
```

**annotations**：`readOnlyHint: false, destructiveHint: false, openWorldHint: true`

**成功返回（`mode: "plan"`）**：
```json
{
  "ok": true,
  "export": {
    "directory": "<绝对路径>",
    "files": [{ "path": "ticket.md" }, ...],
    "contentHash": "<sha256>",
    "action": "created" | "updated" | "unchanged"
  }
}
```

**成功返回（`mode: "write"`）**：
```json
{
  "ok": true,
  "export": {
    "directory": "...",
    "files": [{ "path": "ticket.md", "sha256": "..." }, ...],
    "contentHash": "...",
    "action": "created" | "updated" | "unchanged",
    "exportId": "<uuid>",
    "status": "created" | "updated" | "unchanged"
  }
}
```

**行为细节**：
- 默认 `mode: "plan"`，**不会落盘**。
- `mode: "write"` + `media: "download"`（默认）：下载独立附件 + 描述/评论内联图片。
- `mode: "write"` + `media: "metadata"`：只生成索引文件，不下载二进制。
- 写入用事务会话：暂存 + 锁目录 + 整体 rename；失败回滚。
- 断点续传：已有媒体用 manifest SHA-256 校验后复制到暂存目录，只下载 `missingMedia`。

---

## 7. `ticket_export_my_open_tasks`

**标题**：Export all my open ticket tasks

**描述**：为当前用户、未完成的工作项本地 bundle 生成计划或写入。`statuses` 可只选命名状态（如“新建”）；write 导出默认下载媒体并恢复已校验的本地媒体。

**入参 schema**：
```ts
{
  profile: z.string().min(1),
  limit: z.number().int().min(1).max(1_000).default(1_000),
  mode: z.enum(["plan", "write"]).default("plan"),
  media: z.enum(["metadata", "download"]).default("download"),
  statuses: z.array(z.string().min(1).max(128)).max(20).optional()
}
```

**annotations**：`readOnlyHint: false, destructiveHint: false, openWorldHint: true`

**成功返回**：
```json
{
  "ok": true,
  "export": {
    "matchedCount": M,
    "selectedCount": S,
    "detailCount": S,
    "complete": true,
    "exports": [ /* ExportPlan[] | ExportResult[] */ ]
  }
}
```

**行为细节**：
- `statuses` 最多 20 个，每个 ≤128 字符；未提供时导出全部未完成。
- 先 `listMyOpenDetailsForExport` 读取全部详情（带 statuses 过滤），全部成功后才批量导出。
- `matchedCount`：profile 视角的总匹配数（不受 statuses 影响）。
- `selectedCount` / `detailCount`：实际导出数。
- 每张工单独立事务会话；某一张失败会中断整批，但已写入的会保留（每张是原子的，批不是）。

---

## 8. 工具矩阵速查

| 工具 | 只读 | 开世界 | 默认 mode | 默认 media | 触发浏览器 | 触发下载 |
| --- | --- | --- | --- | --- | --- | --- |
| `ticket_browser_connect` | ✗ | ✓ | — | — | ✓ | ✗ |
| `ticket_browser_disconnect` | ✗ | ✗ | — | — | ✓ | ✗ |
| `ticket_connection_status` | ✓ | ✗ | — | — | 探针 | ✗ |
| `ticket_my_open_tasks` | ✓ | ✓ | — | — | ✗ | ✗ |
| `ticket_get` | ✓ | ✓ | — | — | ✗ | ✗ |
| `ticket_export` | ✗ | ✓ | plan | download | ✗ | write 时 |
| `ticket_export_my_open_tasks` | ✗ | ✓ | plan | download | ✗ | write 时 |

## 9. 入参 schema 校验

- 所有 `profile` 都是 `z.string().min(1)`，空串在 schema 阶段被拒。
- `limit` ∈ [1, 1000]，默认 1000。
- `ticket.id` ∈ [1, 128] 字符。
- `mode` / `media` / `statuses` 都是枚举或受限数组，不接受任意字符串。
- **不接受任意 URL、Header 或 GraphQL 文本**——这是安全边界。

## 10. 错误返回示例

```json
{
  "ok": false,
  "error": {
    "code": "SOURCE_INCOMPLETE",
    "message": "The requested limit does not cover every matching work item; increase limit before requesting details"
  }
}
```

（`isError: true` 也会被设置，供 MCP 客户端识别。）
