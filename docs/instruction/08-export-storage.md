# 08 · 本地导出存储

> 源文件：[src/modules/tickets/infrastructure/export/local-ticket-bundle-store.ts](../src/modules/tickets/infrastructure/export/local-ticket-bundle-store.ts)。

`LocalTicketBundleStore` 实现 `TicketBundleStore` 端口，负责把规范化工单原子落盘到本机。

## 1. 目录布局

```text
<storage.root>/<provider>/<project-or-team>/<ticket-id>/
  ticket.md                              # 人读入口
  attachments/
    README.md                            # 独立附件索引
    <downloaded standalone attachments>  # 独立附件二进制
  assets/
    description/
      README.md                          # 描述内联图片索引
      <downloaded description images>
    comments/
      README.md                          # 评论内联图片索引
      <downloaded comment images>
  _machine/
    ticket.json                          # 完整 CanonicalTicket
    comments.json                        # 评论数组
    relations.json                       # 关系数组
    attachments.json                     # 附件 metadata（不含 sourceUrl）
    media.json                           # 已下载媒体的本地路径与逻辑用途
    manifest.json                        # 哈希清单 + layoutVersion + contentHash
```

- `<provider>`：`ticket.source.provider`（如 `ones`）。
- `<project-or-team>`：`ticket.source.projectId ?? ticket.source.teamId`。
- `<ticket-id>`：`ticket.source.ticketNumber?.trim() || ticket.source.ticketId`。
- 每段都经 `sanitizedSegment` 清理（替换非法字符、去首尾点、限长 120、空兜底 `unnamed`）。

## 2. `LAYOUT_VERSION = 3`

- manifest 中记录 `layoutVersion`。
- 既有 manifest 的 `layoutVersion` 与当前不一致时，`plan` 返回 `action: "updated"`，`write` 会重新生成所有产物。

## 3. 常量

```ts
const LAYOUT_VERSION = 3;
const MACHINE_DIRECTORY = "_machine";
const ATTACHMENTS_INDEX_PATH = "attachments/README.md";
const DESCRIPTION_ASSETS_INDEX_PATH = "assets/description/README.md";
const COMMENT_ASSETS_INDEX_PATH = "assets/comments/README.md";
```

## 4. `plan(ticket, media?)` — 不落盘

```ts
async plan(ticket, media = []): Promise<ExportPlan> {
  const directory = this.directory(ticket);
  const files = [
    "ticket.md",
    ATTACHMENTS_INDEX_PATH,
    DESCRIPTION_ASSETS_INDEX_PATH,
    COMMENT_ASSETS_INDEX_PATH,
    `${MACHINE_DIRECTORY}/ticket.json`,
    `${MACHINE_DIRECTORY}/comments.json`,
    `${MACHINE_DIRECTORY}/relations.json`,
    `${MACHINE_DIRECTORY}/attachments.json`,
    `${MACHINE_DIRECTORY}/media.json`,
    `${MACHINE_DIRECTORY}/manifest.json`,
    ...media.map((item) => item.path),
  ].map((path) => ({ path }));
  const contentHash = sha256(stableJson({ ticket: this.hashableTicket(ticket), media: media.map(({ attachment, roles, path }) => ({ attachment, roles: [...roles].sort(), path })) }));
  // 读取既有 manifest（先 _machine/manifest.json，再根 manifest.json 兼容 v1）
  // action = currentManifest.contentHash === contentHash && currentManifest.layoutVersion === LAYOUT_VERSION ? "unchanged" : (currentManifest ? "updated" : "created")
  return { directory, files, contentHash, action };
}
```

- `contentHash`：基于 `stableJson` 的稳定序列化（键排序），剔除 `fetchedAt` 后的 SHA-256。
- `hashableTicket`：深拷贝后把 `source.fetchedAt` 置空，使内容哈希可幂等比较。
- 兼容 v1：旧版本 manifest 在根目录，新版本在 `_machine/`，两个路径都尝试读。

## 5. `beginExport(ticket, media?)` — 开启事务会话

```ts
async beginExport(ticket, media = []): Promise<TicketExportWriteSession> {
  if (new Set(media.map((item) => item.path)).size !== media.length) throw new TicketError("SOURCE_FAILED", "Media export contains duplicate target paths");
  const directory = this.directory(ticket);
  const exportId = randomUUID();
  const lockDirectory = `${directory}.lock`;
  const stagingDirectory = `${directory}.${exportId}.tmp`;
  this.assertPath(lockDirectory);
  this.assertPath(stagingDirectory);
  try {
    await mkdir(dirname(directory), { recursive: true });
    await mkdir(lockDirectory);  // EEXIST → 另一个导出正在进行
  } catch (error) { ... }
  try {
    const plan = await this.plan(ticket, media);
    await mkdir(stagingDirectory, { recursive: true });
    const existing = await this.readExistingMedia(plan.directory);
    const completed = new Map<string, { sha256: string; contentType?: string }>();
    const missingMedia: TicketMediaPlan[] = [];
    for (const item of media) {
      const expected = existing.manifest.get(item.path);
      const previous = existing.media.get(item.path);
      const hash = expected && this.matchesExistingMedia(item, previous)
        ? await this.copyVerifiedMedia(plan.directory, stagingDirectory, item, expected)
        : undefined;
      if (hash) completed.set(item.path, { sha256: hash, contentType: previous?.contentType });
      else missingMedia.push(item);
    }
    return this.createSession(ticket, media, plan, exportId, lockDirectory, stagingDirectory, missingMedia, completed);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    await rm(lockDirectory, { recursive: true, force: true });
    throw ...;
  }
}
```

### 5.1 锁目录

- `${directory}.lock`：用 `mkdir` 原子创建。已存在（`EEXIST`）→ `SOURCE_FAILED: Another export for this ticket is already in progress`。
- 防止同一工单并发导出互相覆盖。

### 5.2 暂存目录

- `${directory}.${exportId}.tmp`：所有写入先到这里。
- `commit` 时整体 rename 为目标目录；失败 `abort` 删除暂存目录。

### 5.3 已有媒体复用

- `readExistingMedia(directory)`：读 `_machine/manifest.json` 与 `_machine/media.json`，返回 `{ manifest: Map<path, sha256>, media: Map<path, { attachmentId?, hash?, contentType? }> }`。
- `matchesExistingMedia(item, previous)`：`previous.attachmentId === item.attachment.id && (!item.attachment.hash || previous.hash === item.attachment.hash)`。
- `copyVerifiedMedia(sourceDir, stagingDir, item, expected)`：流式复制 + 边读边算 SHA-256；hash 匹配 `expected` 则视为已验证，返回 hash；不匹配或读取失败则删除目标文件，返回 `undefined`（即需重新下载）。
- **断点续传核心**：已存在且 hash 匹配的媒体不会被重复下载。

## 6. `TicketExportWriteSession` 实现（`createSession`）

```ts
private createSession(ticket, media, plan, exportId, lockDirectory, stagingDirectory, missingMedia, completed): TicketExportWriteSession {
  let closed = false;
  const close = async () => { if (closed) return; await rm(lockDirectory, { recursive: true, force: true }); closed = true; };
  const abort = async () => { if (closed) return; try { await rm(stagingDirectory, { recursive: true, force: true }); } finally { await close(); } };
  const pendingByPath = new Map(missingMedia.map((item) => [item.path, item]));
  return {
    missingMedia,
    writeMedia: async (item, download) => {
      // 校验 closed / planned / completed / attachment 一致性
      // 写入 stagingDirectory/item.path，记录 sha256 + contentType
    },
    commit: async () => {
      // 校验 closed / completed.size === media.length
      // plan.action === "unchanged" && missingMedia.length === 0 → 直接读已有哈希，删暂存目录，返回 unchanged
      // 否则生成所有产物（markdown/索引/json/manifest），写入暂存目录
      // commitDirectory(stagingDirectory, plan.directory, exportId)
      // 返回 ExportResult
    },
    abort,
  };
}
```

### 6.1 `writeMedia(item, download)`

- 校验：`closed` / `pendingByPath.has(item.path)` / `!completed.has(item.path)` / 下载的 attachment.id 与 plan 一致。
- 写入 `stagingDirectory/item.path`，记录 `sha256(bytes)` + `contentType`。

### 6.2 `commit()`

- 校验 `completed.size === media.length`，否则 `SOURCE_FAILED: Media export is incomplete; missing attachments must be downloaded before committing`。
- **unchanged 快路径**：`plan.action === "unchanged" && missingMedia.length === 0` → 读已有产物哈希，删暂存目录，返回 `status: "unchanged"`。
- **正常路径**：
  1. 生成 `artifactsWithoutManifest`：`ticket.md`、3 个 README.md、5 个 `_machine/*.json`。
  2. 计算 `manifestFiles`：上述产物 + media 的 sha256。
  3. 生成 `manifest`：`{ schemaVersion, exportId, source: { ticketId, teamId, connector, fetchedAt }, layoutVersion, contentHash, files: manifestFiles, attachmentCount, downloadedMediaCount }`。
  4. 写入所有产物到暂存目录。
  5. `commitDirectory(stagingDirectory, plan.directory, exportId)`。
  6. 返回 `ExportResult`，`status = plan.action === "created" ? "created" : "updated"`。

### 6.3 `commitDirectory(stagingDirectory, destination, exportId)`

```ts
private async commitDirectory(stagingDirectory, destination, exportId): Promise<void> {
  const previousDirectory = `${destination}.${exportId}.previous`;
  this.assertPath(previousDirectory);
  await mkdir(dirname(destination), { recursive: true });
  let movedPrevious = false;
  try { await rename(destination, previousDirectory); movedPrevious = true; } catch (error) { if ((error).code !== "ENOENT") throw error; }
  try { await rename(stagingDirectory, destination); }
  catch (error) { if (movedPrevious) await rename(previousDirectory, destination); throw error; }
  if (movedPrevious) await rm(previousDirectory, { recursive: true, force: true }).catch(() => undefined);
}
```

- **原子替换**：先 rename 旧目录到 `*.previous`，再 rename 暂存目录到目标；失败回滚。
- 新 bundle 提交后保留旧备份比把成功写入误报为失败更安全。

### 6.4 `abort()`

- 删除暂存目录 + 锁目录。

## 7. 产物生成函数

### 7.1 `markdown(ticket, media)` — `ticket.md`

人读入口，包含：
- 标题（`# <title>`）
- 元信息（工单 ID、工单号、类型、状态、优先级、**严重程度**、所属迭代、负责人）
- 描述（`renderBodyWithInlineImages`，内联图片优先用本地链接，否则指向 `assets/description/README.md#<anchor>`）
- 关系（parent/child/related 列表）
- 评论（标题为 `## 评论`；只渲染 `kind === "comment"` 的评论，按时间顺序，正文同样 `renderBodyWithInlineImages`；无评论时显示“暂无评论。”）
- 附件（仅独立附件，嵌入的不在此重复；本地链接或指向 `attachments/README.md#<anchor>`）

### 7.2 `attachmentsIndexMarkdown(ticket, media)` — `attachments/README.md`

- 过滤掉嵌入附件（`isEmbeddedAttachment`）。
- 每个独立附件：名称、类型、大小、Hash、本地文件（已下载 / 尚未下载）。
- 索引锚点 `attachment-<index+1>`。

### 7.3 `descriptionAssetsIndexMarkdown(ticket, media)` — `assets/description/README.md`

- 每张描述图片：alt、资源 ID、本地文件。
- 索引锚点 `description-image-<index+1>`。

### 7.4 `commentAssetsIndexMarkdown(ticket, media)` — `assets/comments/README.md`

- 标题为 `# 评论中的内联图片`（不再包含“与动态”）。
- 每张评论图片：评论 ID、alt、资源 ID、本地文件。
- 索引锚点 `comment-image-<commentIndex+1>-<imageIndex+1>`。

### 7.5 `_machine/*.json`

- `ticket.json`：完整 `CanonicalTicket`（已脱敏，无 `sourceUrl`）。
- `comments.json`：`ticket.comments`。
- `relations.json`：`ticket.relations`。
- `attachments.json`：`ticket.attachments`（无 `sourceUrl`）。
- `media.json`：`mediaRecords` 数组，每项 `{ attachmentId, hash, name, declaredMediaType, contentType, path, roles, downloaded: true }`。
- `manifest.json`：见 §6.2。

## 8. 辅助函数

### 8.1 `stableJson(value)`

```ts
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
```

- 递归按键排序序列化，用于可重复计算 contentHash。

### 8.2 `sha256(value)` / `sha256Bytes(value)`

- 文本与字节的 SHA-256 十六进制摘要。

### 8.3 `sanitizedSegment(value)`

```ts
function sanitizedSegment(value: string): string {
  const normalized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+$/, "_").trim();
  return normalized.slice(0, 120) || "unnamed";
}
```

- 清理目录片段中的非法字符，防止路径穿越和平台非法文件名。

### 8.4 `markdownPlain(value)`

```ts
function markdownPlain(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]<>#+!|])/g, "\\$1")
    .replace(/\((?=javascript:|data:)/gi, "\\(");
}
```

- 转义 Markdown 特殊字符，确保导出内容按纯文本展示。
- 阻断 `javascript:` / `data:` 协议链接。

### 8.5 `isEmbeddedAttachment(ticket, attachment)`

- 该附件是否在描述图片或任一评论图片中被引用。

### 8.6 `mediaLink(from, reference, media)`

- 在 `media` 计划中查找 `reference` 对应的本地路径，返回相对 `from` 的相对路径（`/` 分隔）。

### 8.7 `localizeAttachmentUrls(value, ticket, media)`

- 把正文中可识别的 ONES 附件 URL 替换为已下载文件的相对链接，其他外部链接保持原样。

### 8.8 `renderBodyWithInlineImages(value, images, ticket, media, indexPath, anchorFor)`

- 在正文原位置渲染富文本图片：
  - 已下载 → `![alt](localPath)`
  - 未下载 → `[alt](indexPath#anchor)`
- 用 `\uE000ones-image-<n>\uE001` 占位符避免二次替换干扰。

## 9. 路径安全

### 9.1 `directory(ticket)`

```ts
private directory(ticket): string {
  const root = resolve(this.root);
  const project = ticket.source.projectId ?? ticket.source.teamId;
  const ticketDirectoryName = ticket.source.ticketNumber?.trim() || ticket.source.ticketId;
  const target = resolve(root, sanitizedSegment(ticket.source.provider), sanitizedSegment(project), sanitizedSegment(ticketDirectoryName));
  this.assertPath(target);
  return target;
}
```

### 9.2 `assertPath(target)`

```ts
private assertPath(target): void {
  const root = resolve(this.root);
  if (!isWithinRoot(root, target)) throw new TicketError("EXPORT_ROOT_DENIED", "Export path is outside storage.root");
}
```

### 9.3 `isWithinRoot(root, target)`

```ts
function isWithinRoot(root, target): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}
```

- **所有写入路径都必须在 `storage.root` 内**，否则 `EXPORT_ROOT_DENIED`。
- 每次写入 / 锁 / 暂存 / 媒体文件都调 `assertPath`。

## 10. 不变量

- 一个二进制只保存一次（由 `mediaPlan` 去重 + `media` 计划路径唯一性校验保证）。
- 嵌入附件不在 `attachments/` 重复展示（由 `isEmbeddedAttachment` 过滤）。
- 临时 ONES 附件 URL **绝不持久化**（`redactTicket` 已删 `sourceUrl`，导出物里没有）。
- 导出原子：暂存 + 锁 + 整体 rename；失败回滚。
- 断点续传：已有媒体用 manifest SHA-256 校验后复制，只下载 `missingMedia`。
- `manifest.json` 记录 `layoutVersion` 与 `contentHash`，便于幂等更新判断与布局迁移。
- `_machine/` 只存放完整机器数据与校验信息；人读入口是 `ticket.md`。
- 索引文件（3 个 README.md）始终存在，明确区分“已识别”与“已下载”，避免生成指向不存在二进制文件的失效链接。

## 11. `removeTestDirectory(directory)`

```ts
export async function removeTestDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
```

- **测试专用**，生产代码不调用。
