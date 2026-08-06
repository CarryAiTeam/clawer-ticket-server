# 11 · 错误处理

> 源文件：[src/modules/tickets/domain/ticket-error.ts](../src/modules/tickets/domain/ticket-error.ts)、[src/delivery/mcp/ticket-server.ts](../src/delivery/mcp/ticket-server.ts)、[src/infrastructure/http/fetch-http-client.ts](../src/infrastructure/http/fetch-http-client.ts)。

## 1. 错误类型 `TicketError`

```ts
export type TicketErrorCode =
  | "PROFILE_NOT_FOUND"
  | "CONFIG_INVALID"
  | "SECRET_UNAVAILABLE"
  | "SOURCE_UNAUTHORIZED"
  | "SOURCE_RATE_LIMITED"
  | "HUMAN_ACTION_REQUIRED"
  | "SOURCE_SCHEMA_CHANGED"
  | "SOURCE_INCOMPLETE"
  | "SOURCE_NOT_ALLOWED"
  | "SOURCE_FAILED"
  | "EXPORT_ROOT_DENIED"
  | "PROVIDER_NOT_AVAILABLE";

export class TicketError extends Error {
  constructor(public readonly code: TicketErrorCode, message: string) {
    super(message);
    this.name = "TicketError";
  }
}
```

- **稳定错误码**：12 个枚举值，不随 provider 实现变化。
- **与 provider 无关**：ONES 特有错误在适配器内被翻译成这些码。
- 继承 `Error`，带 `name = "TicketError"` 与 `code`。

## 2. 错误码语义与触发点

### 2.1 `PROFILE_NOT_FOUND`

- **语义**：profile 名称不存在。
- **触发点**：
  - `StaticTicketProfileResolver.get(name)`
  - `OnesConfig.getProfile(config, name)`

### 2.2 `CONFIG_INVALID`

- **语义**：配置文件读取、校验或语义错误。
- **触发点**：
  - `parseConfig`：zod 校验失败、host allowlist 校验失败。
  - `loadConfig`：文件读取失败。
  - `StaticTicketProfileResolver` 构造：profile 名称不唯一。
  - `TicketApplication.browserSessions()`：未配置 browser 能力。
  - `TicketApplication.mediaProvider()`：未配置 media 能力。
  - `OnesGraphqlSource.profileFor`：profile 的 providerId 与当前 provider 不匹配。
  - `OnesBrowserSource.openBrowserSession` / `closeBrowserSession`：profile source 不是 browser。

### 2.3 `SECRET_UNAVAILABLE`

- **语义**：密钥引用在环境中不可用。
- **触发点**：
  - `EnvSecretProvider.resolve(reference)`：`process.env[reference]` 为空。
  - `OnesGraphqlSource.status`：捕获 `SECRET_UNAVAILABLE` 后返回 `credentialAvailable: false`。

### 2.4 `SOURCE_UNAUTHORIZED`

- **语义**：source 拒绝授权（401/403）。
- **触发点**：
  - `parseJsonResponse`：status 401/403。
  - `downloadResolvedAttachment`：status 401/403。
- **注意**：Browser provider 在 401/403 时抛 `HUMAN_ACTION_REQUIRED` 而非 `SOURCE_UNAUTHORIZED`，因为浏览器场景需要人工登录。

### 2.5 `SOURCE_RATE_LIMITED`

- **语义**：source 限流（429）。
- **触发点**：
  - `OnesRateLimitError`（继承 `TicketError`，code 同名）。
  - `parseJsonResponse`：status 429（不会重试）。
  - `requestJson`：status 429（会重试，超过 3 次后抛出）。
  - `downloadResolvedAttachment`：status 429（会重试）。
  - Browser `requestJson` / `downloadAttachment`：status 429（会重试）。
- **重试策略**：见 [09-rate-limit-resume.md](./09-rate-limit-resume.md)。

### 2.6 `HUMAN_ACTION_REQUIRED`

- **语义**：需要人工操作（MFA/验证码/SSO/浏览器登录/Chrome 未找到等）。
- **触发点**：
  - `parseJsonResponse`：响应文本含 `captcha`/`challenge`/`mfa`。
  - `OnesBrowserSource.autoLogin`：登录控件不可见或登录页 host 不在 allowlist。
  - `OnesBrowserSource.ensurePage`：Chrome 未找到 / 启动失败。
  - `OnesBrowserSource.requireActivePage`：页面未开 / 已关闭 / 不同 profile 激活。
  - `OnesBrowserSource.visibleTaskRows`：视图未显示任务行。
  - Browser `requestJson`：status 401/403。
  - Browser `downloadAttachment`：status 401/403。

### 2.7 `SOURCE_SCHEMA_CHANGED`

- **语义**：source 响应不符合预期契约。
- **触发点**：
  - `parseJsonResponse`：非 JSON content-type / JSON 解析失败。
  - `OnesGraphqlSource.graphql`：响应含 `errors` 数组。
  - `OnesGraphqlSource.getRawTicket`：`data.task` 缺失。
  - `OnesGraphqlSource.resolveAttachmentUrl`：未返回 url / url 无效。
  - `OnesGraphqlSource.normalizeIndexItem`：列表项缺 `uuid`。
  - `normalizeOnesTicket`：`detail.uuid` 缺失。
  - `OnesBrowserSource.listMyOpen`：reconciliation 无法识别当前用户 assignee id。

### 2.8 `SOURCE_INCOMPLETE`

- **语义**：source 报告的匹配数与枚举数不一致，或分页未完成。
- **触发点**：
  - `TicketApplication.listMyOpenDetails`：`hasNextPage` 为 true / matched 项数 ≠ `page.matchedCount`。
  - `TicketApplication.listMyOpenDetailsForExport`：同上。
- **设计意图**：绝不以列表摘要代替详情，要求用户增大 `limit` 后重试。

### 2.9 `SOURCE_NOT_ALLOWED`

- **语义**：工单项目不在 profile allowlist。
- **触发点**：
  - `OnesGraphqlSource.assertAllowedProject`：detail.project.uuid 不在 `allowedProjects`。
  - `TicketApplication.getTicket`：二次校验，profile.allowedProjects 非空且工单 projectId 不在其中。

### 2.10 `SOURCE_FAILED`

- **语义**：source 请求失败的通用兜底。
- **触发点**：
  - `parseJsonResponse`：非 2xx 且非 401/403/429。
  - `downloadResolvedAttachment`：非 2xx 且非 401/403/429。
  - `OnesGraphqlSource.requestJson`：endpoint host 不在 allowlist。
  - `OnesGraphqlSource.resolveAttachmentUrl`：临时 URL host 不在 allowlist。
  - `LocalTicketBundleStore.beginExport`：lock 目录已存在（另一个导出正在进行）/ 暂存失败 / media 路径重复。
  - `TicketExportWriteSession.writeMedia`：会话已关闭 / media 不在 pending / attachment 不匹配。
  - `TicketExportWriteSession.commit`：会话已关闭 / media 不完整。

### 2.11 `EXPORT_ROOT_DENIED`

- **语义**：导出路径在 `storage.root` 之外。
- **触发点**：
  - `LocalTicketBundleStore.assertPath`：`isWithinRoot(root, target)` 为 false。
- **防御**：目录计算、暂存目录、锁目录、媒体文件路径都调 `assertPath`。

### 2.12 `PROVIDER_NOT_AVAILABLE`

- **语义**：profile 要求的 provider 与当前注入的 provider 不匹配。
- **触发点**：
  - `TicketApplication.profile(name)`：`profile.providerId !== this.dependencies.provider.providerId`。
- **用途**：防止用 ONES profile 调用 Jira provider（未来）等错配。

## 3. MCP 错误映射

```ts
function errorResult(error: unknown) {
  if (error instanceof TicketError) return textResult({ ok: false, error: { code: error.code, message: error.message } }, true);
  return textResult({ ok: false, error: { code: "UNEXPECTED", message: error instanceof Error ? error.message : "Unexpected error" } }, true);
}
```

- `TicketError` → `{ ok: false, error: { code, message } }` + `isError: true`。
- 其他异常 → `{ ok: false, error: { code: "UNEXPECTED", message } }` + `isError: true`。
- **不泄露未处理异常结构**：非 `TicketError` 只取 `message`，不带 stack。

## 4. 错误返回示例

```json
{
  "ok": false,
  "error": {
    "code": "SOURCE_INCOMPLETE",
    "message": "The requested limit does not cover every matching work item; increase limit before requesting details"
  }
}
```

```json
{
  "ok": false,
  "error": {
    "code": "HUMAN_ACTION_REQUIRED",
    "message": "Open the supervised browser session, sign in to ONES, then retry"
  }
}
```

```json
{
  "ok": false,
  "error": {
    "code": "EXPORT_ROOT_DENIED",
    "message": "Export path is outside storage.root"
  }
}
```

## 5. 错误传播链

```text
Provider 适配器 / Infrastructure
  └─ throw new TicketError(code, message) 或抛出非 TicketError 异常
     └─ TicketApplication 用例捕获 / 转换 / 直接抛出
        └─ Delivery 层 tool handler 的 try/catch
           └─ errorResult(error) 投影为 MCP 错误载荷
```

- **Provider 适配器**负责把 ONES 特有错误翻译成 `TicketError`。
- **Application** 通常不捕获错误（除了 `status` 这类返回 `ConnectionStatus` 的方法），让错误透传到 Delivery。
- **Delivery** 统一在 tool handler 的 `try/catch` 中调 `errorResult`。

## 6. 特殊处理：`status` 方法的错误吞并

`OnesGraphqlSource.status` 与 `OnesBrowserSource.status` 会**吞并**部分错误，返回 `authorized: false` 的 `ConnectionStatus` 而非抛错：

- `SECRET_UNAVAILABLE` → `credentialAvailable: false, authorized: false`。
- 其他 `TicketError` → `credentialAvailable: true, authorized: false, diagnostics: ["online authorization probe failed: <code>"]`。
- Browser `SOURCE_UNAUTHORIZED` / `HUMAN_ACTION_REQUIRED` → `credentialAvailable: true, authorized: false, diagnostics: ["sign in to ONES in the visible browser session, then retry"]`。
- Browser 其他 `TicketError` → `credentialAvailable: true, authorized: false, diagnostics: ["browser authorization probe failed: <code>"]`。

非 `TicketError` 异常仍会抛出（如网络栈错误）。

## 7. 错误恢复建议

| 错误码 | 用户应采取的动作 |
| --- | --- |
| `PROFILE_NOT_FOUND` | 检查配置文件中的 profile 名称 |
| `CONFIG_INVALID` | 检查配置文件 schema、host allowlist、profile 名称唯一性 |
| `SECRET_UNAVAILABLE` | 在 MCP 进程环境中设置 `secretRef` 指向的变量 |
| `SOURCE_UNAUTHORIZED` | GraphQL：检查 token 是否有效；Browser：调 `ticket_browser_connect` 重新登录 |
| `SOURCE_RATE_LIMITED` | 等待后重试；不要调高 `maxRequestsPerMinute` 规避 ONES 限制 |
| `HUMAN_ACTION_REQUIRED` | 在可见浏览器窗口完成 MFA/验证码/SSO/登录；或配置 Chrome 路径 |
| `SOURCE_SCHEMA_CHANGED` | ONES 升级导致契约变化，需更新 provider 适配器 |
| `SOURCE_INCOMPLETE` | 增大 `limit` 参数后重试 |
| `SOURCE_NOT_ALLOWED` | 检查 `allowedProjects` 是否包含该工单的项目 UUID |
| `SOURCE_FAILED` | 查看消息细节；可能是并发导出冲突、host 不在 allowlist、网络错误等 |
| `EXPORT_ROOT_DENIED` | 检查 `storage.root` 配置与导出路径计算 |
| `PROVIDER_NOT_AVAILABLE` | 检查 profile 的 `provider` 与当前注入 provider 是否匹配 |

## 8. 不变量

- 所有端口实现都抛 `TicketError`，不抛厂商异常。
- `TicketError.code` 是稳定枚举，可作为 MCP 客户端的程序化判断依据。
- 非 `TicketError` 异常在 Delivery 层被映射为 `UNEXPECTED`，不泄露 stack。
- `status` 方法是唯一会吞并错误并返回诊断信息的方法；其他方法错误直接传播。
- `OnesRateLimitError` 是 `TicketError` 的子类，code 为 `SOURCE_RATE_LIMITED`，额外携带 `retryAfterMs` 供 `retryRateLimited` 使用。
