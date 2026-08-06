# 06 · ONES Provider 适配器

> 源文件：[src/providers/ones/](../src/providers/ones/)。

ONES 是第一期为 provider 实现的工单系统。它有两种连接器（`source`）：
- `graphql`：用受控机器凭据（`secretRef`）直接调 ONES GraphQL/REST。
- `browser`：开可见 Chrome 窗口，用同源 fetch + CSRF 协商；可选邮箱密码直登。

## 1. 文件结构

| 文件 | 角色 |
| --- | --- |
| [ones-config.ts](../src/providers/ones/ones-config.ts) | zod schema、`loadConfig`、`getProfile`、host allowlist 校验 |
| [ones-contracts.ts](../src/providers/ones/ones-contracts.ts) | `OnesRawTicketData`（detail + messages + attachments） |
| [ones-graphql-source.ts](../src/providers/ones/ones-graphql-source.ts) | `OnesGraphqlSource`：GraphQL + REST provider |
| [ones-browser-source.ts](../src/providers/ones/ones-browser-source.ts) | `OnesBrowserSource extends OnesGraphqlSource`：浏览器 provider |
| [ones-ticket-mapper.ts](../src/providers/ones/ones-ticket-mapper.ts) | `normalizeOnesTicket` + HTML/链接/图片/关系归一化 |

## 2. `OnesGraphqlSource`

实现 `TicketProvider` + `TicketMediaProvider`。

### 2.1 构造

```ts
constructor(
  protected readonly config: OnesConfig,
  private readonly secrets: SecretProvider = new EnvSecretProvider(),
  private readonly http: HttpClient = new FetchHttpClient(),
)
```

- `config`：全局 `OnesConfig`（含所有 profile）。
- `secrets`：默认从进程环境读 `secretRef`。
- `http`：默认 `FetchHttpClient`，`redirect: "manual"`。

### 2.2 GraphQL 查询常量

- `MY_OPEN_TREE_QUERY`：`buckets(... tasks(... includeAncestors: { pathField: "path" }) ...)`，返回树形（含祖先上下文）。
- `MY_OPEN_MATCHED_QUERY`：去掉 `includeAncestors`，只返回 matched 行——用于校准 `matchedFilter`。
- `DETAIL_QUERY`：`task(key)` 详情字段集（含 `desc_rich: description` 别名）。
- `ATTACHMENTS_QUERY`：`task(key) { attachments { uuid size referenceType ref_type: referenceType ... } }`，严格匹配 ONES 3.14 前端字段形态。

### 2.3 `status(ticketProfile)`

```ts
async status(ticketProfile): Promise<ConnectionStatus> {
  const profile = this.profileFor(ticketProfile);
  try {
    await this.resolveToken(profile);
    await this.graphql(profile, MY_OPEN_MATCHED_QUERY, this.myOpenVariables(profile, 1), "authorizationProbe");
    return { configured: true, credentialAvailable: true, authorized: true, diagnostics: ["credential was accepted by the ONES my-open GraphQL contract"] };
  } catch (error) {
    if (error instanceof OnesError && error.code === "SECRET_UNAVAILABLE") return { configured: true, credentialAvailable: false, authorized: false, diagnostics: [error.code] };
    if (error instanceof OnesError) return { configured: true, credentialAvailable: true, authorized: false, diagnostics: [`online authorization probe failed: ${error.code}`] };
    throw error;
  }
}
```

### 2.4 `listMyOpen(ticketProfile, limit)`

```ts
async listMyOpen(ticketProfile, limit): Promise<TicketIndexTree> {
  const profile = this.profileFor(ticketProfile);
  const safeLimit = Math.min(Math.max(limit, 1), 1_000);
  const variables = this.myOpenVariables(profile, safeLimit);
  const response = await this.graphql(profile, MY_OPEN_TREE_QUERY, variables);
  const matchedResponse = await this.graphql(profile, MY_OPEN_MATCHED_QUERY, variables);
  // 解析 buckets[0].tasks → TicketIndexItem[]，按 allowedProjects 过滤
  // matchedIds = matched 查询返回的 id 集合
  // 对每个 item：item.matchedFilter = matchedIds.has(item.id); item.includedAsAncestor = !item.matchedFilter
  // 计算 roots / externalParentIds / page 统计
}
```

**关键变量**（`myOpenVariables`）：
```ts
{
  groupBy: { tasks: {} },
  groupOrderBy: null,
  orderBy: { position: "ASC", createTime: "DESC" },
  filterGroup: [{
    statusCategory_notIn: ["done"],
    assign_in: ["$currentUser"],
    ...(profile.allowedProjects.length > 0 ? { project_in: profile.allowedProjects } : {}),
  }],
  groupFilter: null,
  pagination: { limit: Math.min(limit, 50), preciseCount: false },
  taskLimit: 2_000,
}
```

- `pagination.limit` 上限 50（ONES 单 bucket 限制），但 `taskLimit: 2000` 保证单 bucket 内任务数足够。
- `preciseCount: false`：ONES 的精确计数可能不准，所以 `matchedCount` 优先取 `matchedPageInfo.preciseCount`/`totalCount`，最后用 matched 集合 size 兜底。

### 2.5 `getTicket(ticketProfile, reference)`

```ts
async getTicket(ticketProfile, reference): Promise<CanonicalTicket> {
  const profile = this.profileFor(ticketProfile);
  return normalizeOnesTicket(profile, await this.getRawTicket(ticketProfile, reference));
}
```

### 2.6 `getRawTicket`（protected，可被 browser override 复用缓存）

```ts
protected async getRawTicket(ticketProfile, reference): Promise<OnesRawTicketData> {
  const profile = this.profileFor(ticketProfile);
  const key = this.toTaskKey(reference.id);
  const detailResponse = await this.graphql(profile, DETAIL_QUERY, { key }, "detailGraphql");
  // 校验 data.task 存在 + assertAllowedProject
  const attachmentResponse = await this.graphql(profile, ATTACHMENTS_QUERY, { key }, "attachmentsGraphql");
  const messages = await this.rest(profile, `task/${encodeURIComponent(reference.id)}/messages`, "messages");
  return { detail, messages, attachments: { attachments: asArray(asRecord(attachmentTask).attachments) } };
}
```

- 三次网络请求：详情 GraphQL、附件 GraphQL、消息 REST。
- `toTaskKey(id)`：`id.startsWith("task-") ? id : \`task-${id}\``。

### 2.7 `downloadAttachment(ticketProfile, attachment)`

```ts
async downloadAttachment(ticketProfile, attachment): Promise<TicketMediaDownload> {
  const profile = this.profileFor(ticketProfile);
  const url = await this.resolveAttachmentUrl(profile, attachment.id);
  return this.downloadResolvedAttachment(profile, attachment, url);
}
```

`resolveAttachmentUrl`：
```ts
protected async resolveAttachmentUrl(profile, attachmentId): Promise<URL> {
  const result = asRecord(await this.requestJson(profile, "GET", `res/attachment/${encodeURIComponent(attachmentId)}?op=download&action=download`));
  const value = stringValue(result.url);
  if (!value) throw new OnesError("SOURCE_SCHEMA_CHANGED", "attachment resolver did not return url");
  let url: URL;
  try { url = new URL(value, profile.baseUrl); } catch { throw new OnesError("SOURCE_SCHEMA_CHANGED", "..."); }
  if (!profile.allowedHosts.includes(url.host)) throw new OnesError("SOURCE_FAILED", "attachment resolver returned a host outside the profile allowlist");
  return url;
}
```

- **临时 URL 仅保留在内存中**，绝不写入 `CanonicalTicket`。
- 解析出的 host 必须在 allowlist。

`downloadResolvedAttachment`：
- 走 `withRequestSlot` + `retryRateLimited` + `acquireBudget`。
- `redirect: "manual"`，401/403 → `SOURCE_UNAUTHORIZED`，429 → `OnesRateLimitError`，其他非 2xx → `SOURCE_FAILED`。
- 返回 `{ attachment, bytes: Uint8Array, contentType? }`。

### 2.8 限流与请求预算

详见 [09-rate-limit-resume.md](./09-rate-limit-resume.md)。核心：
- `withRequestSlot(profile, op)`：每个 profile 独立串行队列（基于 `state.tail` Promise 链）。
- `acquireBudget(profile)`：滑动窗口 60s，超过 `maxRequestsPerMinute` 则等待。
- `retryRateLimited(profile, op)`：最多 3 次重试，429 优先用 `Retry-After`，否则指数退避 + jitter。
- `requestState(profile)` 按 `${source}:${baseUrl}:${teamId}` 区分。

### 2.9 `requestJson` / `graphql` / `rest`

- `requestJson(profile, method, relativePath, body?)`：
  - URL：`/project/api/project/team/${teamId}/${relativePath}` 拼接到 `baseUrl`。
  - host 必须在 allowlist。
  - Header：`accept: application/json`，有 body 时 `content-type: application/json`，`Authorization: Bearer <token>` 或 raw token。
  - 走 `withRequestSlot` + `retryRateLimited` + `acquireBudget`。
  - 429 → `OnesRateLimitError`；其余交给 `parseJsonResponse`（401/403 → `SOURCE_UNAUTHORIZED`，429 → `SOURCE_RATE_LIMITED`，captcha/challenge/mfa → `HUMAN_ACTION_REQUIRED`，非 JSON → `SOURCE_SCHEMA_CHANGED`）。
- `graphql(profile, query, variables, stage)`：POST `items/graphql`，检查 `errors` 数组，有则 `SOURCE_SCHEMA_CHANGED`。
- `rest(profile, path, stage)`：GET，错误附加 stage 名。

### 2.10 `normalizeIndexItem(profile, raw)`（protected）

把 ONES 列表行映射为 `TicketIndexItem`：
- `id` ← `task.uuid`（必填，缺失抛 `SOURCE_SCHEMA_CHANGED`）。
- `key` ← `task.key`。
- `title` ← `task.name` ?? `id`。
- `status` ← `task.status.name`。
- `assignee` ← `task.assign`（id/name），否则回退到 `listAssigneeFieldId` 对应的 importantField.value。
- `projectId` ← `task.project.uuid`。
- `parentId` ← `task.parent.uuid`。
- `path` ← `task.path`。
- `childIds` ← `task.subTasks[].uuid`。
- `matchedFilter` 初始为 `"unknown"`，由 `listMyOpen` 后续校准。

## 3. `OnesBrowserSource extends OnesGraphqlSource`

同时实现 `BrowserSessionProvider`。**只对 `source: "browser"` profile 做 browser 特化，其余复用 GraphQL 实现**。

### 3.1 状态字段

```ts
private browser?: Browser;
private context?: BrowserContext;
private page?: Page;
private csrfToken?: string;
private activeProfileName?: string;
private readonly ticketCache = new Map<string, OnesRawTicketData>();
```

- `ticketCache`：reconciliation 时为浏览器可见行预读的 raw 详情，供后续 `getRawTicket` 复用。

### 3.2 `openBrowserSession(ticketProfile)`

```ts
async openBrowserSession(ticketProfile): Promise<BrowserSessionStatus> {
  const profile = this.profileFor(ticketProfile);
  if (profile.source !== "browser") throw new OnesError("CONFIG_INVALID", "...");
  const page = await this.ensurePage(ticketProfile.name, profile);
  const autoLoginConfigured = Boolean(profile.browser?.autoLogin);
  const authorization = autoLoginConfigured
    ? await this.waitForAutoLoginAuthorization(ticketProfile, page)
    : { authorized: false, diagnostics: ["sign in to ONES in the visible browser session, then check connection status"] };
  return { url: page.url(), message: "...", authentication: { mode: autoLoginConfigured ? "auto" : "manual", authorized: authorization.authorized, diagnostics: authorization.diagnostics } };
}
```

### 3.3 `ensurePage(profileName, profile)`（protected）

```ts
protected async ensurePage(profileName, profile): Promise<Page> {
  if (this.page && !this.page.isClosed()) {
    if (this.activeProfileName !== profileName) throw new OnesError("HUMAN_ACTION_REQUIRED", "A different browser profile is active; close it before connecting this profile");
    return this.page;
  }
  const executablePath = profile.browser?.executablePath ?? process.env.ONES_BROWSER_EXECUTABLE_PATH ?? DEFAULT_CHROME_PATHS.find(existsSync);
  if (!executablePath) throw new OnesError("HUMAN_ACTION_REQUIRED", "Chrome was not found. ...");
  this.browser = await chromium.launch({ executablePath, headless: false, args: ["--no-first-run", "--no-default-browser-check"] });
  this.context = await this.browser.newContext();
  this.page = await this.context.newPage();
  const startUrl = profile.browser?.myOpenViewUrl ?? new URL(`/project/#/workspace/team/${encodeURIComponent(profile.teamId)}`, profile.baseUrl).toString();
  await this.page.goto(startUrl, { waitUntil: "domcontentloaded" });
  this.activeProfileName = profileName;
  await this.autoLogin(profile, this.page);
  return this.page;
}
```

- **可见窗口**（`headless: false`），**内存 context**（不持久化个人资料目录）。
- 默认 Chrome 路径：`C:/Program Files/Google/Chrome/Application/chrome.exe` 与 `(x86)` 版本。
- 先绑定 `activeProfileName` 再 `autoLogin`，确保自动登录失败时仍可在此窗口手动完成。

### 3.4 `autoLogin(profile, page)`（protected）

```ts
protected async autoLogin(profile, page): Promise<void> {
  const login = profile.browser?.autoLogin;
  if (!login) return;
  try {
    await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
    if (!this.isAllowedBrowserPage(profile, page)) throw new Error("login page is outside the host allowlist");
    const emailInput = page.locator(DIRECT_LOGIN_ACCOUNT_SELECTOR).first();
    const passwordInput = page.locator(DIRECT_LOGIN_PASSWORD_SELECTOR).first();
    await emailInput.waitFor({ state: "visible", timeout: 10_000 });
    await passwordInput.waitFor({ state: "visible", timeout: 10_000 });
    await emailInput.fill(login.email);
    await passwordInput.fill(login.password);
    await page.locator(DIRECT_LOGIN_SUBMIT_SELECTOR).first().click();
  } catch {
    throw new OnesError("HUMAN_ACTION_REQUIRED", "The configured browser auto-login could not complete a controlled direct email/password login. ...");
  }
}
```

- 选择器覆盖邮箱/用户名/账号/密码/提交按钮的中英文常见命名。
- **只处理标准邮箱密码表单**；MFA/验证码/SSO/二次确认/自定义页面立即抛 `HUMAN_ACTION_REQUIRED`。

### 3.5 `waitForAutoLoginAuthorization`

```ts
private async waitForAutoLoginAuthorization(ticketProfile, page): Promise<ConnectionStatus> {
  let authorization = { configured: true, credentialAvailable: true, authorized: false, diagnostics: ["browser authorization is pending"] };
  for (const delay of AUTO_LOGIN_AUTHORIZATION_DELAYS_MS) {  // [500, 1000, 2000, 4000]
    await page.waitForTimeout(delay);
    authorization = await this.status(ticketProfile);
    if (authorization.authorized) return authorization;
  }
  return authorization;
}
```

- 目标系统提交后可能异步建立会话，用有界稀疏探测等待，避免超出请求预算。

### 3.6 `status` override

```ts
override async status(ticketProfile): Promise<ConnectionStatus> {
  const profile = this.profileFor(ticketProfile);
  if (profile.source !== "browser") return super.status(ticketProfile);
  if (!this.page || this.page.isClosed() || this.activeProfileName !== ticketProfile.name) {
    return { configured: true, credentialAvailable: false, authorized: false, diagnostics: ["open the supervised browser session and sign in to ONES before using this profile"] };
  }
  try {
    await super.listMyOpen(ticketProfile, 1);  // 窄范围探针
    return { configured: true, credentialAvailable: true, authorized: true, diagnostics: ["the visible supervised browser session was accepted by ONES"] };
  } catch (error) {
    if (error instanceof OnesError && (error.code === "SOURCE_UNAUTHORIZED" || error.code === "HUMAN_ACTION_REQUIRED")) {
      return { configured: true, credentialAvailable: true, authorized: false, diagnostics: ["sign in to ONES in the visible browser session, then retry"] };
    }
    if (error instanceof OnesError) return { configured: true, credentialAvailable: true, authorized: false, diagnostics: [`browser authorization probe failed: ${error.code}`] };
    throw error;
  }
}
```

### 3.7 `listMyOpen` override — reconciliation

```ts
override async listMyOpen(ticketProfile, limit): Promise<TicketIndexTree> {
  const profile = this.profileFor(ticketProfile);
  const index = await super.listMyOpen(ticketProfile, limit);  // 复用 GraphQL 实现
  if (profile.source !== "browser") return index;
  const existingMatches = index.items.filter((item) => item.matchedFilter === true);
  if (!profile.browser?.myOpenViewUrl) return index;
  // 用 currentAssigneeIds/names 作为排除父级的依据
  const visibleRows = await this.visibleTaskRows(profile);
  for (const { id, text: rowText } of visibleRows) {
    if (knownIds.has(id)) continue;
    if (currentAssigneeNames.size > 0 && ![...currentAssigneeNames].some((name) => rowText.includes(name))) continue;
    const raw = await super.getRawTicket(ticketProfile, { id });
    const assigneeId = text(asRecord(asRecord(raw.detail).assign).uuid);
    if (!assigneeId || !currentAssigneeIds.has(assigneeId)) continue;
    this.ticketCache.set(id, raw);  // 缓存，供后续 getRawTicket 复用
    const item = this.normalizeIndexItem(profile, raw.detail);
    item.matchedFilter = true;
    item.includedAsAncestor = false;
    index.items.push(item);
  }
  return this.rebuildTree(index);
}
```

**为什么需要 reconciliation**：部分 ONES 租户在 GraphQL 中报告的待办数与实际枚举行不一致。Browser profile 可配置 `browser.myOpenViewUrl`，连接器在发现差异时读取该视图中可见的工单路由，按当前用户负责人 ID/显示名排除父级上下文，并继续用同源 GraphQL/REST 获取完整详情。

`visibleTaskRows`：导航到 `myOpenViewUrl`，最多重试 6 次（每次 250ms）读取 `a[href*="/task/"]` 链接的 href 与 innerText，去重返回 `{ id, text }[]`。

`rebuildTree`：根据新增/过滤后的索引项重新计算 roots / externalParentIds / page 统计；对 browser profile，校准后的当前用户工单行才是权威 `matchedCount`。

### 3.8 `getRawTicket` override — 复用缓存

```ts
protected override async getRawTicket(ticketProfile, reference): Promise<OnesRawTicketData> {
  const cached = this.ticketCache.get(reference.id);
  if (cached) return cached;
  return super.getRawTicket(ticketProfile, reference);
}
```

### 3.9 `requestJson` override — 同源 fetch + CSRF

```ts
protected override async requestJson(profile, method, relativePath, body?): Promise<unknown> {
  if (profile.source !== "browser") return super.requestJson(profile, method, relativePath, body);
  return this.withRequestSlot(profile, () => this.retryRateLimited(profile, async () => {
    await this.acquireBudget(profile);
    const page = this.requireActivePage(profile);
    const endpoint = new URL(`/project/api/project/team/${encodeURIComponent(profile.teamId)}/${relativePath}`, profile.baseUrl);
    if (!profile.allowedHosts.includes(endpoint.host)) throw new OnesError("SOURCE_FAILED", "...");
    const result = await page.evaluate(async ({ url, method, body, csrfToken }) => {
      const headers = { accept: "application/json", "Accept-Language": navigator.language };
      if (body) headers["content-type"] = "application/json";
      if (csrfToken) headers["X-CSRF-TOKEN"] = csrfToken;
      else headers["X-REQUEST-CSRF-TOKEN"] = "1";
      const response = await fetch(url, { method, headers, credentials: "include", ...(body ? { body } : {}) });
      return { status: response.status, text: await response.text(), contentType: response.headers.get("content-type") ?? "", csrfToken: response.headers.get("x-csrf-token") ?? undefined, retryAfter: response.headers.get("retry-after") ?? undefined };
    }, { url: endpoint.toString(), method, body, csrfToken: this.csrfToken });
    if (result.csrfToken) this.csrfToken = result.csrfToken;
    if (result.status === 429) throw this.rateLimited("ONES request was rate limited", result.retryAfter ?? null);
    if (result.status === 401 || result.status === 403) throw new OnesError("HUMAN_ACTION_REQUIRED", "ONES requires an authenticated visible browser session; sign in and retry");
    return parseJsonResponse({ status: result.status, headers: new Headers({ "content-type": result.contentType }), text: result.text });
  }));
}
```

- **同源 fetch**：在浏览器页面上下文内 `fetch(url, { credentials: "include" })`，复用页面 Cookie。
- **CSRF 协商**：首次请求带 `X-REQUEST-CSRF-TOKEN: 1`，从响应头 `x-csrf-token` 取 token，后续请求带 `X-CSRF-TOKEN`。
- 不读取/复制/打印/持久化 Cookie、密码、localStorage、浏览器个人资料。

### 3.10 `downloadAttachment` override

```ts
override async downloadAttachment(ticketProfile, attachment): Promise<TicketMediaDownload> {
  const profile = this.profileFor(ticketProfile);
  if (profile.source !== "browser") return super.downloadAttachment(ticketProfile, attachment);
  const url = await this.resolveAttachmentUrl(profile, attachment.id);
  return this.withRequestSlot(profile, () => this.retryRateLimited(profile, async () => {
    await this.acquireBudget(profile);
    const page = this.requireActivePage(profile);
    const encoded = await page.evaluate(async (value) => {
      const response = await fetch(value, { credentials: "include" });
      if (!response.ok) return { status: response.status, contentType: ..., retryAfter: ..., base64: "" };
      const bytes = new Uint8Array(await response.arrayBuffer());
      // 分块 base64 编码（0x8000 字节一块）
      return { status: response.status, contentType: ..., retryAfter: ..., base64: btoa(binary) };
    }, url.toString());
    if (encoded.status === 401 || encoded.status === 403) throw new OnesError("HUMAN_ACTION_REQUIRED", "...");
    if (encoded.status === 429) throw this.rateLimited("attachment download was rate limited", encoded.retryAfter ?? null);
    if (encoded.status < 200 || encoded.status >= 300) throw new OnesError("SOURCE_FAILED", `attachment download returned ${encoded.status}`);
    return { attachment, bytes: Uint8Array.from(Buffer.from(encoded.base64, "base64")), ...(encoded.contentType ? { contentType: encoded.contentType } : {}) };
  }));
}
```

- 同样走同源 fetch + 限流 + 重试。
- 二进制通过 base64 中转跨 `page.evaluate` 边界。

### 3.11 `requireActivePage(profile)`

```ts
private requireActivePage(profile): Page {
  if (!this.page || this.page.isClosed()) throw new OnesError("HUMAN_ACTION_REQUIRED", "Open the supervised browser session, sign in to ONES, then retry");
  if (this.activeProfileName && this.activeProfileName !== this.profileName(profile)) throw new OnesError("HUMAN_ACTION_REQUIRED", "A different browser profile is active; close it before connecting this profile");
  return this.page;
}
```

### 3.12 `closeBrowserSession`

```ts
async closeBrowserSession(ticketProfile): Promise<void> {
  const profile = this.profileFor(ticketProfile);
  if (profile.source !== "browser") throw new OnesError("CONFIG_INVALID", "...");
  await this.browser?.close();
  this.browser = undefined;
  this.context = undefined;
  this.page = undefined;
  this.csrfToken = undefined;
  this.activeProfileName = undefined;
  this.ticketCache.clear();
}
```

## 4. `normalizeOnesTicket`（mapper）

详见 [02-domain-model.md §9](./02-domain-model.md) 的字段映射表。这里补充 mapper 内的纯函数：

- `toPerson(value)`：从 ONES 人员对象提取 `id`/`displayName`；**支持字符串入参**（直接作为 `id` 返回），兼容 ONES 部分接口直接返回用户 UUID 的形态。
- `decodeHtml(value)`：解码 `&nbsp;` / `&amp;` / `&lt;` / `&gt;` / `&quot;` / `&#39;`。
- `htmlAttribute(attributes, name)`：正则读取 HTML 属性值（支持双引号/单引号/无引号）。
- `imagesInHtml(value)`：`<img>` 标签 → `TicketInlineImage[]`，**来源 URL 不离开此边界**。`attachmentId` 按 `data-uuid` → `data-ref-id` → `data-resource-id` → `data-attachment-id` 顺序匹配首个非空值，兼容更多 ONES 图片数据格式；不再对结果去重，保留全部匹配图片。
- `safeLink(value)`：只保留 HTTP(S)，清空 username/password/search/hash。
- `stripHtml(value)`：保留 `<a>` 链接文本 + URL、`<img>` alt 占位、`<br>`/`</p>` 等换行；移除其余标签；折叠多余空行。
- `findBody(message)`：从 ONES 消息对象提取 `body`/`sourceFormat`/`images`。优先级：顶层 `rich_text`/`content`/`body`/`message`/`text` → `ext.rich_text`/`ext.content` 等 → `resource`/`file`/`attachment` 资源（图片资源构造 `[image: name]` + `TicketInlineImage`，非图片资源构造 `attachment: name`）→ 兜底 `action` 文本。ONES 详情页讨论消息使用顶层 `rich_text`/`text`，旧版消息才用 `content`/`body` 或 `ext.content`。
- `normalizeMessages(raw)`：消息流 → `TicketComment[]`。**只保留 `comment`/`discussion`/`resource` 类型的消息**，创建、更新等系统动态不导出；`kind` 恒为 `"comment"`。兼容多种消息容器（数组 / `messages` / `data.messages` / `items` / `data.items`）。`author` 解析增强：`from`/`from_user` + `from_name`/`fromName` 兜底。`createdAt` 多字段兜底：`send_time`/`sendTime`/`createdAt`/`create_time`。
- `normalizeAttachments(detail, raw)`：合并 detail 与 raw.attachments，按 uuid 去重。
- `normalizeRelations(detail)`：parent/subTasks/relatedTasks/links → `TicketRelation[]`。
- `normalizeIteration(detail)`：sprint → `TicketIteration`。
- `normalizeOnesTicket` 额外提取 `severity`：importantFields 中 `name === "严重程度"` 的 `value`。
- `sourceValueFor(rule, detail, fields)`：按 `field` 类型取待比较值。
- `classify(rules, detail, fields)`：按规则顺序匹配，返回 `classification`。

## 5. 两种连接器对比

| 维度 | graphql | browser |
| --- | --- | --- |
| 认证 | `secretRef` 环境变量 → Bearer/raw token | 浏览器会话 Cookie + CSRF |
| 请求 | `FetchHttpClient`（`redirect: "manual"`） | `page.evaluate` 同源 fetch |
| 限流 | profile 级串行 + 滑动窗口 | 同左（复用） |
| 429 | `OnesRateLimitError` + `Retry-After` | 同左 |
| 401/403 | `SOURCE_UNAUTHORIZED` | `HUMAN_ACTION_REQUIRED` |
| `listMyOpen` | 一次 tree + 一次 matched | 同左 + 可选 reconciliation（读 `myOpenViewUrl` 可见行） |
| `downloadAttachment` | fetch 临时 URL | `page.evaluate` fetch 临时 URL + base64 中转 |
| 临时附件 URL | 内存 | 内存 |
| 凭据持久化 | 否（每次 `resolveToken`） | 否（关浏览器即丢） |
| 适用场景 | 有只读机器 token 的租户 | 只接受网页登录的租户 |

## 6. 不变量

- 原始 ONES 响应（`OnesRawTicketData`）**绝不离开 provider 边界**。
- 临时附件 URL **绝不写入 `CanonicalTicket`**，只存在于 `downloadAttachment` 的栈帧中。
- Browser 不读取/复制/打印/持久化 Cookie、密码、localStorage、个人资料目录。
- 所有出站请求的 host 必须在 `profile.allowedHosts`。
- `OnesBrowserSource` 是 `OnesGraphqlSource` 的子类，但**只对 `source === "browser"` 的 profile 走 browser 路径**，其余复用 GraphQL 实现——这是“同一 provider 的两种连接器”局部化策略。
