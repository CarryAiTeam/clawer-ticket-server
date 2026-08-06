# 03 · 端口接口（Ports）

> 源文件：[src/modules/tickets/domain/ports.ts](../src/modules/tickets/domain/ports.ts)。

端口是领域层定义、由适配器实现的契约。`TicketApplication` 只依赖端口，不知道 ONES、文件系统或 Playwright 的存在。

## 1. Profile 相关

### 1.1 `TicketProfile`

```ts
export interface TicketProfile {
  name: string;
  providerId: string;       // "ones"
  connector: string;        // "graphql" | "browser"
  allowedProjects: string[];
  inlineMaxChars: number;
}
```

- 与 provider 无关的 profile 投影。由 `StaticTicketProfileResolver` 从 ONES 配置中提取（见 [bootstrap](../src/bootstrap/create-server.ts) 的 `ticketProfiles`）。
- `allowedProjects`：空数组表示该 team 内不限制项目；非空时只有这些项目 UUID 的工单允许返回。

### 1.2 `TicketProfileResolver`

```ts
export interface TicketProfileResolver {
  get(name: string): TicketProfile;
}
```

- 不存在抛 `PROFILE_NOT_FOUND`。
- 实现见 [12-infrastructure.md](./12-infrastructure.md) 的 `StaticTicketProfileResolver`。

## 2. 连接状态 `ConnectionStatus`

```ts
export interface ConnectionStatus {
  configured: boolean;
  authorized: boolean;
  diagnostics: string[];
  credentialAvailable?: boolean;
}
```

- `configured`：profile 配置本身是否完整。
- `credentialAvailable`：密钥是否可用（GraphQL）/ 浏览器会话是否已开（Browser）。
- `authorized`：在线只读探针是否通过。
- `diagnostics`：人类可读诊断字符串数组，不含秘密。

## 3. 工单 Provider 端口 `TicketProvider`

```ts
export interface TicketProvider {
  readonly providerId: string;
  status(profile: TicketProfile): Promise<ConnectionStatus>;
  listMyOpen(profile: TicketProfile, limit: number): Promise<TicketIndexTree>;
  getTicket(profile: TicketProfile, reference: TicketReference): Promise<CanonicalTicket>;
}
```

- **核心读路径端口**。返回值都是领域契约，原始厂商响应不跨越此边界。
- `listMyOpen`：返回树形索引（含祖先上下文 + matched 标记），不读取详情。
- `getTicket`：返回单张已归一化工单（未脱敏，脱敏在 Application 层做）。
- 实现：`OnesGraphqlSource`（GraphQL）/ `OnesBrowserSource`（Browser，override 部分）。

## 4. 媒体端口 `TicketMediaProvider` / `TicketMediaDownload`

```ts
export interface TicketMediaDownload {
  attachment: TicketAttachment;
  bytes: Uint8Array;
  contentType?: string;
}

export interface TicketMediaProvider {
  downloadAttachment(profile: TicketProfile, attachment: TicketAttachment): Promise<TicketMediaDownload>;
}

export type TicketMediaMode = "metadata" | "download";
```

- **显式能力边界**：读取工单元数据 ≠ 下载二进制媒体。
- `bytes` 只流向本地导出存储，**绝不进入 MCP 响应**。
- `TicketMediaMode`：
  - `"metadata"`：只保存元数据，不下载二进制。
  - `"download"`：下载独立附件 + 描述/评论内联图片。
- 实现：`OnesGraphqlSource.downloadAttachment`（先解析临时 URL 再 fetch）/ `OnesBrowserSource.downloadAttachment`（同源 fetch via `page.evaluate`）。

## 5. 媒体计划 `TicketMediaPlan`

```ts
export interface TicketMediaPlan {
  attachment: TicketAttachment;
  roles: Array<"attachment" | "description-image" | "comment-image">;
  path: string;
}
```

- 由 `TicketApplication.mediaPlan(ticket)` 计算（见 [04-application-service.md](./04-application-service.md)）。
- `roles`：同一二进制可能在描述图片、评论图片、独立附件中多次出现；`mediaPlan` 会合并 roles。
- `path`：相对导出目录的路径：
  - 嵌入描述 → `assets/description/<id>-<name>`
  - 嵌入评论 → `assets/comments/<id>-<name>`
  - 独立附件 → `attachments/<id>-<name>`
- 去重键：`hash:<hash>` 优先，否则 `id:<id>`。

## 6. 导出存储端口 `TicketBundleStore` / `TicketExportWriteSession`

### 6.1 `ExportFile` / `ExportPlan` / `ExportResult`

```ts
export interface ExportFile {
  path: string;
  sha256?: string;
}

export interface ExportPlan {
  directory: string;
  files: ExportFile[];
  contentHash: string;
  action: "created" | "updated" | "unchanged";
}

export interface ExportResult extends ExportPlan {
  files: Array<ExportFile & { sha256: string }>;
  exportId: string;
  status: "created" | "updated" | "unchanged";
}
```

- `plan` 模式返回 `ExportPlan`（不落盘），`write` 模式返回 `ExportResult`（含每文件 SHA-256）。
- `action`/`status`：
  - `created`：目标目录无既有 manifest。
  - `updated`：既有 manifest 但 `contentHash` 或 `layoutVersion` 变了。
  - `unchanged`：`contentHash` + `layoutVersion` 都一致，且无缺失媒体。

### 6.2 `TicketExportWriteSession`

```ts
export interface TicketExportWriteSession {
  readonly missingMedia: readonly TicketMediaPlan[];
  writeMedia(plan: TicketMediaPlan, download: TicketMediaDownload): Promise<void>;
  commit(): Promise<ExportResult>;
  abort(): Promise<void>;
}
```

- **事务型本地导出会话**。
- `beginExport` 暂存已有媒体（用 manifest SHA-256 校验复制），返回 `missingMedia`（仍需下载的项）。
- 应用层补齐 `missingMedia` 后 `commit`；任一下载失败 `abort` 回滚暂存目录。
- `commit` 仅在所有媒体都已 `writeMedia` 后才整体 rename 暂存目录为目标目录。
- 实现：`LocalTicketBundleStore`（见 [08-export-storage.md](./08-export-storage.md)）。

### 6.3 `TicketBundleStore`

```ts
export interface TicketBundleStore {
  plan(ticket: CanonicalTicket, media?: TicketMediaPlan[]): Promise<ExportPlan>;
  beginExport(ticket: CanonicalTicket, media?: TicketMediaPlan[]): Promise<TicketExportWriteSession>;
}
```

- `plan`：计算目录、文件清单、contentHash、action，不落盘。
- `beginExport`：开启事务会话。

## 7. 浏览器会话端口 `BrowserSessionProvider` / `BrowserSessionStatus`

```ts
export interface BrowserSessionStatus {
  url: string;
  message: string;
  authentication: {
    mode: "auto" | "manual";
    authorized: boolean;
    diagnostics: string[];
  };
}

export interface BrowserSessionProvider {
  openBrowserSession(profile: TicketProfile): Promise<BrowserSessionStatus>;
  closeBrowserSession(profile: TicketProfile): Promise<void>;
}
```

- **可选的受监督能力**，刻意与工单读取能力分离。
- `TicketApplication` 通过 `browserSessions()` 私有方法访问；未配置时抛 `CONFIG_INVALID`：“The configured ticket source does not support supervised browser sessions”。
- `mode`：
  - `"auto"`：profile 配置了 `browser.autoLogin`，已提交邮箱密码直登。
  - `"manual"`：未配置 autoLogin，需用户在可见窗口自行登录。
- 实现：`OnesBrowserSource`（同时是 `TicketProvider` 和 `BrowserSessionProvider`）。

## 8. 端口与实现的对应

| 端口 | GraphQL 实现 | Browser 实现 |
| --- | --- | --- |
| `TicketProvider` | `OnesGraphqlSource` | `OnesBrowserSource`（override `status`/`listMyOpen`/`getRawTicket`） |
| `TicketMediaProvider` | `OnesGraphqlSource.downloadAttachment` | `OnesBrowserSource.downloadAttachment`（override） |
| `BrowserSessionProvider` | — | `OnesBrowserSource` |
| `TicketBundleStore` | `LocalTicketBundleStore`（与 provider 无关） | 同左 |
| `TicketProfileResolver` | `StaticTicketProfileResolver`（与 provider 无关） | 同左 |

## 9. 端口设计要点

1. **读路径与媒体路径分离**：`TicketProvider` 只读元数据，`TicketMediaProvider` 才下载二进制；这样 `ticket_get` 永不触发二进制下载，`ticket_export` 才按需调用。
2. **浏览器能力可选**：`BrowserSessionProvider` 是 `TicketApplication` 的可选依赖；GraphQL-only profile 永远不会开浏览器。
3. **事务会话**：`TicketExportWriteSession` 把“暂存已有 + 下载缺失 + 原子提交”封装在端口里，应用层只管调度，不接触文件系统细节。
4. **错误码统一**：所有端口实现都抛 `TicketError`，不抛厂商异常，Delivery 层据此映射为 MCP 错误载荷。
