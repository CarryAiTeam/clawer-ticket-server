# 04 · 应用服务（TicketApplication）

> 源文件：[src/modules/tickets/application/ticket-application.ts](../src/modules/tickets/application/ticket-application.ts)。

`TicketApplication` 是用例编排中心。它依赖端口，不直接接触 ONES、文件系统、Playwright。所有 MCP 工具的调用最终都落到这里的 7 个公开方法。

## 1. 依赖注入

```ts
export interface TicketApplicationDependencies {
  profiles: TicketProfileResolver;
  provider: TicketProvider;
  bundleStore: TicketBundleStore;
  redaction: TicketRedactionPolicy;
  browserSessions?: BrowserSessionProvider;
  mediaProvider?: TicketMediaProvider;
}
```

- 由 `bootstrap/create-server.ts` 的 `createTicketApplication` 装配：
  - `profiles` ← `StaticTicketProfileResolver`
  - `provider` ← `OnesBrowserSource`（同时是 `BrowserSessionProvider`）
  - `bundleStore` ← `LocalTicketBundleStore(config.storage.root)`
  - `redaction` ← `config.storage.redaction`
  - `browserSessions` ← `provider`（同一对象）
  - `mediaProvider` ← `provider`（同一对象）

## 2. 公开方法一览

| 方法 | 对应 MCP 工具 | 说明 |
| --- | --- | --- |
| `connectionStatus(profile)` | `ticket_connection_status` | 查询 profile 连接状态 + provider/项目范围 |
| `openBrowserSession(profile)` | `ticket_browser_connect` | 打开受监督浏览器会话 |
| `closeBrowserSession(profile)` | `ticket_browser_disconnect` | 关闭会话并清理内存登录态 |
| `listMyOpen(profile, limit)` | `ticket_my_open_tasks`（`includeDetails:false`） | 只读树形索引 |
| `listMyOpenDetails(profile, limit)` | `ticket_my_open_tasks`（默认 `includeDetails:true`） | 索引 + 逐条详情 |
| `getTicket(profile, reference)` | `ticket_get`（基础） | 已归一化 + 项目校验 + 脱敏 |
| `getTicketInline(profile, reference)` | `ticket_get` | 在 `getTicket` 之上按预算裁剪 |
| `exportTicket(profile, reference, mode, mediaMode)` | `ticket_export` | 单张计划或写入 |
| `exportMyOpenTickets(profile, limit, mode, mediaMode, statuses?)` | `ticket_export_my_open_tasks` | 批量计划或写入 |

## 3. 方法详解

### 3.1 `connectionStatus(profile)`

```ts
async connectionStatus(profile: string) {
  const selectedProfile = this.profile(profile);
  const status = await this.dependencies.provider.status(selectedProfile);
  return { profile, provider: selectedProfile.providerId, connector: selectedProfile.connector, allowedProjects: selectedProfile.allowedProjects, ...status };
}
```

- 先 `this.profile(profile)` 校验 profile 存在且 provider 匹配。
- 调 `provider.status`，把 `ConnectionStatus` 与 profile 元信息合并返回。

### 3.2 `openBrowserSession(profile)` / `closeBrowserSession(profile)`

```ts
async openBrowserSession(profile: string) {
  return this.browserSessions().openBrowserSession(this.profile(profile));
}
async closeBrowserSession(profile: string): Promise<void> {
  await this.browserSessions().closeBrowserSession(this.profile(profile));
}
```

- `browserSessions()`：私有方法，未配置时抛 `CONFIG_INVALID`。

### 3.3 `listMyOpen(profile, limit)`

```ts
async listMyOpen(profile: string, limit: number) {
  return this.dependencies.provider.listMyOpen(this.profile(profile), limit);
}
```

- 直接转发，不读取详情。返回 `TicketIndexTree`。

### 3.4 `listMyOpenDetails(profile, limit)` — 关键不变量

```ts
async listMyOpenDetails(profile: string, limit: number) {
  const index = await this.listMyOpen(profile, limit);
  if (index.page.hasNextPage) {
    throw new TicketError("SOURCE_INCOMPLETE", "The requested limit does not cover every matching work item; increase limit before requesting details");
  }
  const matches = index.items.filter((item) => item.matchedFilter === true);
  if (matches.length !== index.page.matchedCount) {
    throw new TicketError("SOURCE_INCOMPLETE", `Provider reported ${index.page.matchedCount} matching work items but enumerated ${matches.length}; details were not partially returned`);
  }
  const tickets: CanonicalTicket[] = [];
  for (const item of matches) tickets.push(await this.getTicket(profile, { id: item.id }));
  return { ...index, tickets, detailCount: tickets.length, complete: true as const };
}
```

- **三道安全闸**：
  1. `hasNextPage` 为 `true` → 抛 `SOURCE_INCOMPLETE`，要求增大 `limit`。
  2. matched 项数 ≠ `page.matchedCount` → 抛 `SOURCE_INCOMPLETE`，拒绝部分返回。
  3. 逐条 `getTicket`，任一失败整体失败，**绝不以列表摘要代替详情**。
- 只对 `matchedFilter === true` 的项读取详情，父级上下文项不读详情。

### 3.5 `getTicket(profile, reference)`

```ts
async getTicket(profile: string, reference: TicketReference): Promise<CanonicalTicket> {
  const selectedProfile = this.profile(profile);
  const ticket = await this.dependencies.provider.getTicket(selectedProfile, reference);
  if (selectedProfile.allowedProjects.length > 0 && (!ticket.source.projectId || !selectedProfile.allowedProjects.includes(ticket.source.projectId))) {
    throw new TicketError("SOURCE_NOT_ALLOWED", "Ticket project is outside the profile allowlist");
  }
  return redactTicket(ticket, this.dependencies.redaction);
}
```

- **项目 allowlist 二次校验**（provider 内部已校验一次，这里是防御性二次）。
- **脱敏前置**：返回前必过 `redactTicket`。

### 3.6 `getTicketInline(profile, reference)`

```ts
async getTicketInline(profile: string, reference: TicketReference): Promise<InlineTicket> {
  const selectedProfile = this.profile(profile);
  return projectTicketForInline(await this.getTicket(profile, reference), selectedProfile.inlineMaxChars);
}
```

- 在已脱敏的 `getTicket` 结果上按 `inlineMaxChars` 裁剪。
- 裁剪算法见 [02-domain-model.md §10](./02-domain-model.md)。

### 3.7 `exportTicket(profile, reference, mode, mediaMode = "download")`

```ts
async exportTicket(profile, reference, mode, mediaMode = "download"): Promise<ExportPlan | ExportResult> {
  const ticket = await this.getTicket(profile, reference);
  const media = mediaMode === "download" ? this.mediaPlan(ticket) : [];
  if (mode === "plan") return this.dependencies.bundleStore.plan(ticket, media);
  return this.downloadMissingMedia(profile, ticket, media);
}
```

- **先 `getTicket`（含脱敏）再导出**：导出物里没有 `sourceUrl`、没有 `removeFields` 字段。
- `media: "metadata"` 时 `media = []`，导出物只有元数据索引，不下载二进制。
- `mode: "plan"` 只返回 `ExportPlan`，不落盘。

### 3.8 `exportMyOpenTickets(profile, limit, mode, mediaMode, statuses?)`

```ts
async exportMyOpenTickets(profile, limit, mode, mediaMode = "download", statuses?) {
  const detailed = await this.listMyOpenDetailsForExport(profile, limit, statuses);
  const exports: Array<ExportPlan | ExportResult> = [];
  for (const ticket of detailed.tickets) {
    const media = mediaMode === "download" ? this.mediaPlan(ticket) : [];
    if (mode === "plan") exports.push(await this.dependencies.bundleStore.plan(ticket, media));
    else exports.push(await this.downloadMissingMedia(profile, ticket, media));
  }
  return { matchedCount: detailed.page.matchedCount, selectedCount: detailed.tickets.length, detailCount: detailed.detailCount, complete: detailed.complete, exports };
}
```

- `listMyOpenDetailsForExport`：与 `listMyOpenDetails` 类似，但多了 `statuses` 过滤：
  ```ts
  const selected = selectedStatuses?.length
    ? expected.filter((item) => item.status && selectedStatuses.includes(item.status))
    : expected;
  ```
- **先全部读取详情成功，再批量导出**——避免失败时落盘不完整的摘要数据。
- 返回 `matchedCount`（profile 视角的总匹配）、`selectedCount`（实际导出数，受 statuses 影响）、`detailCount`、`complete`、`exports`。

### 3.9 `downloadMissingMedia(profile, ticket, media)` — 事务会话调度

```ts
private async downloadMissingMedia(profile, ticket, media): Promise<ExportResult> {
  const session = await this.dependencies.bundleStore.beginExport(ticket, media);
  const selectedProfile = this.profile(profile);
  try {
    for (const item of session.missingMedia) {
      await session.writeMedia(item, await this.mediaProvider().downloadAttachment(selectedProfile, item.attachment));
    }
    return await session.commit();
  } catch (error) {
    await session.abort();
    throw error;
  }
}
```

- `beginExport` 已暂存并校验已有媒体，返回 `missingMedia`。
- 应用层只下载 `missingMedia`，已存在的不会被重复下载（断点续传）。
- 任一 `writeMedia` 失败 → `abort` 回滚暂存目录，重新抛出错误。

## 4. 私有工具方法

### 4.1 `mediaPlan(ticket)` — 媒体去重与角色合并

```ts
private mediaPlan(ticket: CanonicalTicket): TicketMediaPlan[] {
  const byIdentity = new Map<string, TicketMediaPlan>();
  const add = (attachment, role) => {
    const identity = attachment.hash ? `hash:${attachment.hash}` : `id:${attachment.id}`;
    // 已存在则合并 roles；新增则按 embedded 决定 primary 目录
    ...
  };
  for (const attachment of ticket.attachments) add(attachment, "attachment");
  for (const image of ticket.descriptionImages ?? []) { /* 找到对应附件 add(attachment, "description-image") */ }
  for (const comment of ticket.comments) for (const image of comment.images ?? []) { /* add(attachment, "comment-image") */ }
  return [...byIdentity.values()];
}
```

- 去重键：`hash:<hash>` 优先，否则 `id:<id>`。**一个二进制只保存一次**。
- `primary` 目录选择：
  - 嵌入描述图片 → `assets/description`
  - 嵌入评论图片 → `assets/comments`
  - 独立附件 → `attachments`
- `path`：`${primary}/${attachment.id}-${safeMediaName(attachment.name)}`。

### 4.2 `safeMediaName(value)`

```ts
function safeMediaName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 120) || "unnamed";
}
```

- 清理非法文件名字符，限长 120，空串兜底 `unnamed`。

### 4.3 `profile(name)` — provider 匹配校验

```ts
private profile(name: string): TicketProfile {
  const profile = this.dependencies.profiles.get(name);
  if (profile.providerId !== this.dependencies.provider.providerId) {
    throw new TicketError("PROVIDER_NOT_AVAILABLE", `Profile ${name} requires provider ${profile.providerId}, but ${this.dependencies.provider.providerId} is configured`);
  }
  return profile;
}
```

- 防止用 ONES profile 调用 Jira provider（未来）等错配。

### 4.4 `browserSessions()` / `mediaProvider()`

```ts
private browserSessions(): BrowserSessionProvider {
  if (!this.dependencies.browserSessions) throw new TicketError("CONFIG_INVALID", "...");
  return this.dependencies.browserSessions;
}
private mediaProvider(): TicketMediaProvider {
  if (!this.dependencies.mediaProvider) throw new TicketError("CONFIG_INVALID", "...");
  return this.dependencies.mediaProvider;
}
```

- 可选依赖的门禁方法，未配置时给明确的可操作错误。

## 5. `projectTicketForInline(ticket, contentLimit)` — 内联裁剪算法

```ts
export function projectTicketForInline(ticket: CanonicalTicket, contentLimit: number): InlineTicket {
  const maxMetadataItems = 100;
  const omittedAttachmentCount = Math.max(0, ticket.attachments.length - maxMetadataItems);
  const omittedRelationCount = Math.max(0, ticket.relations.length - maxMetadataItems);
  const omittedCustomFieldCount = Math.max(0, ticket.customFields.length - maxMetadataItems);
  const descriptionLimit = Math.floor(contentLimit * 0.6);
  const description = ticket.descriptionMarkdown ? clip(ticket.descriptionMarkdown, descriptionLimit) : undefined;
  let remaining = contentLimit - (description?.consumed ?? 0);
  let truncated = description?.truncated ?? false;
  let omittedCommentCount = 0;
  const comments = [];
  for (const comment of ticket.comments) {
    if (remaining <= 0 || comments.length >= maxMetadataItems) { omittedCommentCount += 1; truncated = true; continue; }
    const body = clip(comment.bodyMarkdown, Math.min(2_000, remaining));
    remaining -= body.consumed;
    truncated ||= body.truncated;
    comments.push({ ...comment, bodyMarkdown: body.value });
  }
  return { ...ticket, ...(description ? { descriptionMarkdown: description.value } : {}), comments,
    attachments: ticket.attachments.slice(0, maxMetadataItems),
    relations: ticket.relations.slice(0, maxMetadataItems),
    customFields: ticket.customFields.slice(0, maxMetadataItems),
    inline: { contentLimit, contentChars: contentLimit - remaining, truncated: truncated || omittedAttachmentCount > 0 || omittedRelationCount > 0 || omittedCustomFieldCount > 0, omittedCommentCount, omittedAttachmentCount, omittedRelationCount, omittedCustomFieldCount } };
}
```

`clip` 行为：

```ts
function clip(value: string, maxChars: number): { value: string; consumed: number; truncated: boolean } {
  if (value.length <= maxChars) return { value, consumed: value.length, truncated: false };
  if (maxChars <= 1) return { value: "…", consumed: 0, truncated: true };
  return { value: `${value.slice(0, maxChars - 1)}…`, consumed: maxChars, truncated: true };
}
```

- `consumed` 是计入预算的字符数；截断时为 `maxChars`（不含省略号），未截断时为原长。

## 6. 不变量与边界

- **详情完整性**：`listMyOpenDetails` / `exportMyOpenTickets` 必须先全部读取详情成功，绝不部分返回。
- **脱敏前置**：`getTicket` 是所有读路径的漏斗，返回前必脱敏；导出物也走 `getTicket`，所以导出物里没有 `sourceUrl`。
- **项目 allowlist**：`getTicket` 二次校验，profile 内 `allowedProjects` 非空时工单 projectId 必须在其中。
- **媒体去重**：`mediaPlan` 保证一个二进制只下载一次，roles 合并。
- **事务回滚**：`downloadMissingMedia` 任一失败 `abort`，暂存目录被清理。
- **可选能力门禁**：浏览器 / 媒体能力未配置时抛 `CONFIG_INVALID`，不留空指针。
