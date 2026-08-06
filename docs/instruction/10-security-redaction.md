# 10 · 安全与脱敏

> 源文件：[src/modules/tickets/domain/ticket-policy.ts](../src/modules/tickets/domain/ticket-policy.ts)、[src/providers/ones/ones-ticket-mapper.ts](../src/providers/ones/ones-ticket-mapper.ts)、[src/infrastructure/http/fetch-http-client.ts](../src/infrastructure/http/fetch-http-client.ts)、[src/providers/ones/ones-config.ts](../src/providers/ones/ones-config.ts)。

## 1. 安全设计原则

1. **provider 由受控配置选择，不能由 MCP 工具参数指定。**
2. **原始厂商响应不跨越 provider 边界**，只有 `CanonicalTicket` 进入应用层。
3. **二进制内容不进入 MCP 响应**，只流向本地导出存储。
4. **临时 ONES 附件 URL 永不持久化**，只存在于内存中用于一次性下载。
5. **脱敏前置**：工单进入 MCP 返回或持久化前应用 `redactTicket`。
6. **host allowlist**：所有出站请求（含浏览器、附件解析）都必须落在 `allowedHosts`。
7. **不绕过人工挑战**：MFA/验证码/SSO 立即停止，交由用户在可见窗口完成。
8. **不持久化浏览器会话**：关浏览器或 MCP 重启即丢弃登录态。

## 2. 脱敏策略 `redactTicket`

```ts
export interface TicketRedactionPolicy {
  omitPeople: boolean;
  removeFields: string[];
}

export function redactTicket(ticket: CanonicalTicket, policy: TicketRedactionPolicy): CanonicalTicket {
  const clone = JSON.parse(JSON.stringify(ticket)) as CanonicalTicket;
  const blockedFields = new Set(policy.removeFields.map((field) => field.trim().toLocaleLowerCase()));
  clone.customFields = clone.customFields.filter((field) => {
    const name = field.name?.trim().toLocaleLowerCase();
    const id = field.id.trim().toLocaleLowerCase();
    return !blockedFields.has(name ?? "") && !blockedFields.has(id);
  });
  if (policy.omitPeople) {
    delete clone.assignee;
    delete clone.reporter;
    clone.comments = clone.comments.map(({ author: _author, ...comment }) => comment);
  }
  // 附件 URL 可能携带短期凭据，不能作为可导出的元数据保留。
  clone.attachments = clone.attachments.map(({ sourceUrl: _sourceUrl, ...attachment }) => attachment);
  return clone;
}
```

### 2.1 行为

- **深拷贝**：`JSON.parse(JSON.stringify(ticket))`，不修改原对象。
- **`removeFields`**：按字段 `name` 或 `id`（小写 trim）匹配，过滤 `customFields`。默认 `["phone", "email"]`。
- **`omitPeople`**：删除 `assignee` / `reporter`，评论移除 `author`。
- **无条件删除 `sourceUrl`**：即使 `removeFields` 不包含，每个附件的 `sourceUrl` 都被删除（附件 URL 可能携带短期凭据）。

### 2.2 调用点

- `TicketApplication.getTicket`：返回前必过 `redactTicket`。
- 所有导出路径（`exportTicket` / `exportMyOpenTickets`）都先 `getTicket`，所以**导出物里没有 `sourceUrl`**。

### 2.3 配置

```json
{
  "storage": {
    "redaction": {
      "omitPeople": false,
      "removeFields": ["phone", "email"]
    }
  }
}
```

- `omitPeople` 默认 `false`。
- `removeFields` 默认 `["phone", "email"]`。

## 3. 富文本清洗（mapper 层）

`ones-ticket-mapper.ts` 内的纯函数在归一化阶段就清洗 ONES 富文本，**在脱敏之前**已经移除了危险内容。

### 3.1 `safeLink(value)`

```ts
function safeLink(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}
```

- 只保留 HTTP(S) 链接。
- 清空 username/password/search/hash。
- 阻断 `javascript:` / `data:` / `file:` 等协议。
- 评论链接可保留上下文，但凭据和跟踪查询参数不能保留。

### 3.2 `stripHtml(value)`

```ts
function stripHtml(value: string): string {
  const withLinks = value
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attributes, label) => {
      const display = decodeHtml(label.replace(/<[^>]*>/g, "")).trim() || "link";
      const href = htmlAttribute(attributes, "href");
      const target = href ? safeLink(href) : undefined;
      return target ? `${display} (${target})` : display;
    })
    .replace(/<img\b([^>]*)>/gi, (_match, attributes) => `[image: ${htmlAttribute(attributes, "alt") ?? "image"}]`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, "\n");
  return decodeHtml(withLinks.replace(/<[^>]*>/g, "")).replace(/\n{3,}/g, "\n\n").trim();
}
```

- 保留 `<a>` 链接的显示文本 + 安全 URL。
- `<img>` 替换为 `[image: alt]` 占位（实际图片引用由 `imagesInHtml` 单独提取）。
- `<br>` / `</p>` / `</div>` 等 → 换行。
- 其余标签全部移除。
- HTML 实体解码 + 折叠多余空行。
- **不执行 HTML、不加载远程图片**。

### 3.3 `imagesInHtml(value)`

```ts
function imagesInHtml(value: string | undefined): TicketInlineImage[] {
  if (!value) return [];
  return [...value.matchAll(/<img\b([^>]*)>/gi)].flatMap((match) => {
    const attributes = match[1] ?? "";
    const attachmentId = htmlAttribute(attributes, "data-uuid");
    const source = htmlAttribute(attributes, "src");
    let hash: string | undefined;
    try {
      const path = new URL(source ?? "https://invalid.example.test").pathname;
      hash = /^\/api\/project\/file\/attachment\/([^/]+)$/i.exec(path)?.[1];
    } catch { /* 来源 URL 不会离开此解析边界 */ }
    const image: TicketInlineImage = {
      ...(attachmentId ? { attachmentId } : {}),
      ...(hash ? { hash } : {}),
      ...(htmlAttribute(attributes, "alt") ? { alt: ... } : {}),
      ...(htmlAttribute(attributes, "data-mime") ? { mediaType: ... } : {}),
      ...(htmlAttribute(attributes, "data-size") ? { sizeHint: ... } : {}),
    };
    return Object.keys(image).length > 0 ? [image] : [];
  });
}
```

- 只提取稳定标识：`attachmentId`（data-uuid）、`hash`（从 src 路径解析）、`alt`、`mediaType`、`sizeHint`。
- **来源 URL 不离开此边界**：`source` 只用于解析 hash，不存入 `TicketInlineImage`。

## 4. HTTP 响应安全 `parseJsonResponse`

```ts
export function parseJsonResponse(response: HttpResponse): unknown {
  if (response.status === 401 || response.status === 403) throw new TicketError("SOURCE_UNAUTHORIZED", `Source returned ${response.status}`);
  if (response.status === 429) throw new TicketError("SOURCE_RATE_LIMITED", "Source rate limit reached");
  if (response.status < 200 || response.status >= 300) throw new TicketError("SOURCE_FAILED", `Source returned ${response.status}`);
  if (/captcha|challenge|mfa/i.test(response.text)) throw new TicketError("HUMAN_ACTION_REQUIRED", "Source requires human authentication action");
  if (!response.headers.get("content-type")?.toLocaleLowerCase().includes("application/json")) {
    throw new TicketError("SOURCE_SCHEMA_CHANGED", "Source response is not JSON");
  }
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    throw new TicketError("SOURCE_SCHEMA_CHANGED", "Source did not return JSON matching the configured contract");
  }
}
```

- 401/403 → `SOURCE_UNAUTHORIZED`。
- 429 → `SOURCE_RATE_LIMITED`。
- 非 2xx → `SOURCE_FAILED`。
- 响应文本含 `captcha`/`challenge`/`mfa`（不区分大小写）→ `HUMAN_ACTION_REQUIRED`。
- 非 JSON content-type → `SOURCE_SCHEMA_CHANGED`。
- JSON 解析失败 → `SOURCE_SCHEMA_CHANGED`。

## 5. Host allowlist

### 5.1 配置校验

`parseConfig` 在 zod 校验后：
- `baseUrl.host` 必须在 `allowedHosts`。
- `browser.myOpenViewUrl.host` 必须在 `allowedHosts`。
- `browser.autoLogin.loginUrl.host` 必须在 `allowedHosts`。

### 5.2 运行时校验

- `requestJson`：拼接 URL 后检查 `endpoint.host`。
- `resolveAttachmentUrl`：解析出的临时 URL 的 host 必须在 allowlist，否则 `SOURCE_FAILED`。
- `downloadResolvedAttachment`：fetch 临时 URL（已校验过 host）。
- Browser `requestJson`：同样校验 `endpoint.host`。
- Browser `autoLogin`：导航后检查 `page.url().host` 在 allowlist，否则抛错。
- `FetchHttpClient`：`redirect: "manual"`，不跟随服务端控制的跳转，以免访问 allowlist 之外的主机。

## 6. 浏览器会话安全

### 6.1 不持久化

- `chromium.launch({ headless: false })` + `browser.newContext()`：**内存 context**，不使用持久化个人资料目录。
- `closeBrowserSession` 关闭 browser / context / page，清空 `csrfToken` / `activeProfileName` / `ticketCache`。
- MCP 重启即丢弃登录态。

### 6.2 不读取/复制/持久化敏感数据

- **不读取**：Cookie、localStorage、密码、浏览器个人资料。
- **不复制**：不导出 Cookie 到 MCP 响应或日志。
- **不打印**：不打印 Cookie、密码、localStorage。
- **不持久化**：会话只存在于 MCP 进程内存。

### 6.3 同源 fetch

- Browser `requestJson` / `downloadAttachment` 都通过 `page.evaluate` 在页面上下文内 `fetch(url, { credentials: "include" })`。
- 复用页面 Cookie，但**不读取 Cookie 值**——只让浏览器自己带上。
- CSRF token 从响应头 `x-csrf-token` 取，存内存，关浏览器即丢。

### 6.4 直登自动化边界

- `autoLogin` 只处理标准邮箱密码表单：
  - 邮箱选择器覆盖 `input[type='email']` / `input[name='email'/'username'/'account'/'login_name'/'loginName']` / `input[autocomplete='email'/'username']` / 中文 placeholder。
  - 密码选择器覆盖 `input[type='password']` / `input[name='password'/'passwd'/'pwd']` / `input[autocomplete='current-password']` / 中文 placeholder。
  - 提交选择器覆盖 `button[type='submit']` / `input[type='submit']` / `button:has-text('登录')` / `button:has-text('登 录')`。
- **遇到以下情况立即停止**（抛 `HUMAN_ACTION_REQUIRED`）：
  - MFA（多因素认证）
  - CAPTCHA（验证码）
  - SSO 确认
  - 二次确认
  - 不兼容的登录页面（控件不可见）
- 不绕过任何人工挑战。

### 6.5 直登凭据存储

- `browser.autoLogin.email` / `password` 只能存放于**本地且被 Git 忽略的配置文件**。
- 不写入 MCP 工具参数。
- 不写入日志。
- 不复制到其他位置。

## 7. 凭据安全

### 7.1 GraphQL profile

- `secretRef` 指向环境变量名（如 `ONES_READ_TOKEN`）。
- `EnvSecretProvider` 从 `process.env` 读取，空值抛 `SECRET_UNAVAILABLE`。
- **不支持在 JSON 配置中直接填写 `token`**。
- token 只用于构造 `Authorization` 头，不写入日志、不写入导出物、不返回给 MCP 客户端。

### 7.2 Browser profile

- 不需要 `secretRef`。
- 直登凭据（`autoLogin.email/password`）存本地配置文件。
- 提交后立即从内存中丢弃表单值（Playwright `fill` 后不保留引用）。

### 7.3 临时附件 URL

- `resolveAttachmentUrl` 解析出的 URL **只存在于 `downloadAttachment` 的栈帧中**。
- 不写入 `CanonicalTicket`（`redactTicket` 还会无条件删 `sourceUrl`）。
- 不写入日志。
- 不写入导出物（`_machine/media.json` 只记录 `attachmentId`/`hash`/`path`/`roles`，不记录 URL）。

## 8. 导出物安全

### 8.1 路径边界

- 所有写入路径都经 `assertPath` 校验在 `storage.root` 内，否则 `EXPORT_ROOT_DENIED`。
- 目录片段经 `sanitizedSegment` 清理，防止路径穿越。

### 8.2 内容安全

- `markdownPlain` 转义 Markdown 特殊字符，阻断 `javascript:` / `data:` 协议链接。
- `localizeAttachmentUrls` 只替换可识别的 ONES 附件 URL，其他外部链接保持原样。
- 评论富文本只保留安全文本、HTTP(S) 链接（去掉 query/hash）和图片提示，不执行 HTML 或加载远程图片。
- 索引文件明确区分“已识别”与“已下载”，避免生成指向不存在二进制文件的失效链接。

### 8.3 manifest 完整性

- `_machine/manifest.json` 记录每个产物的 sha256、`layoutVersion`、`contentHash`、`exportId`。
- 便于后续校验、布局迁移和幂等更新判断。
- 媒体文件 sha256 在 `writeMedia` 时计算并记录；其他产物 sha256 在 `commit` 时计算。

## 9. 协议层安全

- MCP 传输仅 stdio：不开放网络端口。
- 启动错误写 stderr；正常运行**绝不向 stdout 写普通日志**（stdout 是 MCP JSON-RPC 通道）。
- `errorResult` 把非 `TicketError` 的异常映射为 `UNEXPECTED`，**不泄露未处理异常结构**。
- 工具入参 schema 严格校验（zod），**不接受任意 URL、Header 或 GraphQL 文本**。

## 10. 安全检查清单

| 检查项 | 实现位置 |
| --- | --- |
| provider 不能由工具参数指定 | `bootstrap/create-server.ts` |
| 原始响应不跨越 provider 边界 | `OnesGraphqlSource.getTicket` → `normalizeOnesTicket` |
| 二进制不进入 MCP 响应 | `TicketMediaProvider` 端口；`ticket_get` 不调 `downloadAttachment` |
| 临时 URL 不持久化 | `resolveAttachmentUrl` + `redactTicket` 无条件删 `sourceUrl` |
| 脱敏前置 | `TicketApplication.getTicket` |
| host allowlist | `parseConfig` + `requestJson` + `resolveAttachmentUrl` + `autoLogin` |
| 不绕过人工挑战 | `autoLogin` 选择器 + `parseJsonResponse` captcha 检测 |
| 浏览器不持久化 | `chromium.launch` 内存 context + `closeBrowserSession` 清理 |
| 凭据不写入配置 | `secretRef` 引用环境变量；`autoLogin` 存本地受 Git 忽略 |
| 凭据不写入日志/参数 | `errorResult` 不泄露；工具 schema 不接受凭据 |
| 导出路径边界 | `assertPath` + `sanitizedSegment` |
| Markdown 注入 | `markdownPlain` + `safeLink` |
| 协议层不开放网络 | stdio 传输 |
