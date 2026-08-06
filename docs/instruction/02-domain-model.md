# 02 · 领域模型（Domain Model）

> 源文件：[src/modules/tickets/domain/ticket.ts](../src/modules/tickets/domain/ticket.ts)、[ticket-error.ts](../src/modules/tickets/domain/ticket-error.ts)、[ticket-policy.ts](../src/modules/tickets/domain/ticket-policy.ts)。

领域层是**与 provider 无关**的稳定契约。所有 ONES 特有字段在 provider 适配器内被翻译成这里定义的类型，绝不反向污染。

## 1. 工单分类 `TicketClass`

```ts
export type TicketClass = "bugfix" | "feature" | "technical-change" | "unclassified";
```

- 由 profile 的 `classificationRules` 决定（见 [07-config-secrets.md](./07-config-secrets.md)）。
- 规则匹配顺序即数组顺序；未命中任何规则时为 `"unclassified"`。
- `bugfix` / `feature` / `technical-change` 是受控枚举，`unclassified` 是兜底。

## 2. 工单引用 `TicketReference`

```ts
export interface TicketReference {
  /** provider 为单个工单颁发的稳定标识。 */
  id: string;
}
```

- 只承载稳定 ID。对于 ONES，`id` 是工单 UUID（可能带 `task-` 前缀，由 `toTaskKey` 规整）。
- 不允许在此携带 URL、GraphQL key、自定义字段等。

## 3. 人员 `Person`

```ts
export interface Person {
  id?: string;
  displayName?: string;
}
```

- 最小化人员信息。`id` 与 `displayName` 都可选，但至少一个有值才被保留（见 `toPerson`）。
- 不携带邮箱、手机号、头像 URL——这些在脱敏或归一化阶段已被剔除。

## 4. 评论 / 动态 `TicketComment`

```ts
export interface TicketComment {
  id: string;
  author?: Person;
  bodyMarkdown: string;
  createdAt?: string;
  sourceFormat: "plain" | "rich-text" | "activity";
  kind: "comment" | "activity";
  /** 原始富文本中内联图片的安全引用，绝不包含来源 URL。 */
  images?: TicketInlineImage[];
}
```

- `sourceFormat`：
  - `"plain"`：纯文本（无 HTML 标签）。
  - `"rich-text"`：富文本，已通过 `stripHtml` 清洗为可读 Markdown（保留 HTTP(S) 链接、图片 alt 占位、换行）。
  - `"activity"`：仅作为 `findBody` 兜底时的格式标记；`normalizeMessages` 现在会过滤掉系统动态，不再产出该类型的评论。
- `kind`：当前实现中 `normalizeMessages` 只保留 `comment`/`discussion`/`resource` 类型的消息（创建、更新等系统动态不导出），`kind` 恒为 `"comment"`。类型联合仍保留 `"activity"` 以兼容领域契约定义。
- `images`：从富文本或 `resource`/`file`/`attachment` 资源中提取的图片安全引用（见下节），**绝不包含来源 URL**。

## 5. 内联图片 `TicketInlineImage`

```ts
export interface TicketInlineImage {
  /** 图片由附件资源承载时对应的 ONES 附件 UUID。 */
  attachmentId?: string;
  /** 可用时，从受控 ONES 附件路径解析出的稳定内容哈希。 */
  hash?: string;
  alt?: string;
  mediaType?: string;
  sizeHint?: string;
}
```

- 由 `imagesInHtml` 从 `<img>` 标签解析：
  - `attachmentId` 按 `data-uuid` → `data-ref-id` → `data-resource-id` → `data-attachment-id` 顺序匹配首个非空值（兼容更多 ONES 图片数据格式）
  - `src` 路径匹配 `/api/project/file/attachment/([^/]+)` → `hash`（**来源 URL 本身不离开此边界**）
  - `alt` → `alt`
  - `data-mime` → `mediaType`
  - `data-size` → `sizeHint`
- 另一类来源：`findBody` 在消息无文本正文但携带 `resource`/`file`/`attachment` 时，若该资源 mime 以 `image/` 开头，会直接构造一个 `TicketInlineImage`（`attachmentId` 为资源 uuid，含 `alt`/`mediaType`/`sizeHint`）。
- 用途：导出时按 `attachmentId` 或 `hash` 与附件列表匹配，决定该图片是否已下载、放在 `assets/description` 还是 `assets/comments`。

## 6. 附件 `TicketAttachment`

```ts
export interface TicketAttachment {
  id: string;
  name: string;
  mediaType?: string;
  sizeBytes?: number;
  hash?: string;
  sourceUrl?: string;
}
```

- `sourceUrl` 在 `redactTicket` 中**被强制删除**（附件 URL 可能携带短期凭据），所以**持久化或返回给 MCP 的附件绝不会有 `sourceUrl`**。
- `hash` 是 ONES 返回的附件 hash，用于去重与断点续传校验。
- 附件下载用 `id` 调用 `res/attachment/{id}?op=download&action=download` 解析出**临时** URL，该 URL 只存在于内存中用于一次性 fetch。

## 7. 迭代 `TicketIteration`

```ts
export interface TicketIteration {
  id: string;
  name: string;
  plannedStartAt?: string;
  plannedEndAt?: string;
}
```

- 由 `normalizeIteration` 从 `detail.sprint` 映射；`id` 与 `name` 都必须有值才返回。
- `plannedStartAt` / `plannedEndAt` 来自 `sprint.planStartTime` / `sprint.planEndTime`。

## 8. 工单关系 `TicketRelation`

```ts
export interface TicketRelation {
  type: "parent" | "child" | "related";
  targetId: string;
  targetKey?: string;
  title?: string;
}
```

- `parent`：`detail.parent`。
- `child`：`detail.subTasks` 每一项。
- `related`：`detail.relatedTasks` + `detail.links` 合并（`links` 用 `taskUUID` 作为 id）。

## 9. 规范化工单 `CanonicalTicket`（核心）

```ts
export interface CanonicalTicket {
  schemaVersion: "1.0";
  source: {
    provider: string;             // "ones"
    product: "project";
    tenantBaseUrl: string;
    teamId: string;
    projectId?: string;
    projectName?: string;
    ticketId: string;
    ticketKey?: string;           // ONES GraphQL key，如 task-<uuid>
    ticketNumber?: string;        // ONES 面向用户展示的工单编号
    fetchedAt: string;            // ISO 时间
    connector: "graphql" | "browser";
  };
  classification: { value: TicketClass; matchedRule?: string; sourceValue?: string };
  title: string;
  descriptionMarkdown?: string;
  descriptionImages?: TicketInlineImage[];
  status?: string;
  priority?: string;
  severity?: string;             // ONES 自定义字段“严重程度”
  iteration?: TicketIteration;
  assignee?: Person;
  reporter?: Person;
  createdAt?: string;
  updatedAt?: string;
  comments: TicketComment[];
  attachments: TicketAttachment[];
  relations: TicketRelation[];
  customFields: Array<{ id: string; name?: string; value?: string }>;
}
```

字段来源（`normalizeOnesTicket`）：

| CanonicalTicket 字段 | ONES 来源 |
| --- | --- |
| `source.ticketId` | `detail.uuid`（必填，缺失抛 `SOURCE_SCHEMA_CHANGED`） |
| `source.ticketKey` | `detail.key` |
| `source.ticketNumber` | importantFields 中 `name === "ID"` 的 `value`，否则 `detail.number` |
| `source.projectId/projectName` | `detail.project.uuid/name` |
| `title` | `detail.name` ?? `id` |
| `descriptionMarkdown` | `detail.description` ?? `desc_rich` ?? `descriptionText`，经 `stripHtml` |
| `descriptionImages` | 上述描述文本中 `<img>` 解析 |
| `status` | `detail.status.name` |
| `priority` | `detail.priority.name` ?? `detail.priority.value` ?? `detail.priority` |
| `severity` | importantFields 中 `name === "严重程度"` 的 `value` |
| `assignee` | `detail.assign` |
| `reporter` | `detail.owner` |
| `createdAt` | `detail.createTime` |
| `updatedAt` | `detail.serverUpdateStamp` |
| `comments` | `normalizeMessages(raw.messages)` |
| `attachments` | `normalizeAttachments(detail, raw.attachments)`（去重） |
| `relations` | `normalizeRelations(detail)` |
| `customFields` | `detail.importantField` → `{ id: fieldUUID, name, value }` |
| `classification` | `classify(profile.classificationRules, detail, fields)` |

## 10. 内联工单 `InlineTicket`

```ts
export interface InlineTicket extends CanonicalTicket {
  inline: {
    contentLimit: number;
    contentChars: number;
    truncated: boolean;
    omittedCommentCount: number;
    omittedAttachmentCount: number;
    omittedRelationCount: number;
    omittedCustomFieldCount: number;
  };
}
```

- 由 `projectTicketForInline(ticket, contentLimit)` 生成，专给 `ticket_get` 的 MCP 内联响应。
- 裁剪规则：
  - 描述预算 = `floor(contentLimit * 0.6)`，超出加 `…`。
  - 评论按剩余预算逐条裁剪，单条上限 2000 字符；预算耗尽或满 100 条则 `omittedCommentCount++`。
  - 附件 / 关系 / 自定义字段统一截断到前 100 项，超出计入 `omitted*Count`。
  - `truncated` 任一截断发生即为 `true`。
- **导出永远使用完整 `CanonicalTicket`，不用 `InlineTicket`。**

## 11. 索引项 `TicketIndexItem` 与索引树 `TicketIndexTree`

```ts
export interface TicketIndexItem {
  id: string;
  key?: string;
  title: string;
  status?: string;
  assignee?: Person;
  projectId?: string;
  parentId?: string;
  path?: string;
  childIds: string[];
  /** 私有列表接口不会标识作为祖先节点注入的行。 */
  matchedFilter: boolean | "unknown";
  includedAsAncestor: boolean;
}

export interface TicketIndexTree {
  view: "my_open_tree";
  items: TicketIndexItem[];
  roots: string[];
  externalParentIds: string[];
  page: {
    count: number;          // 树中所有行（含祖先上下文）
    matchedCount: number;   // 匹配“当前用户 + 未完成”的行
    contextCount: number;   // 未匹配的上下文行
    totalCount?: number;
    hasNextPage: boolean;
  };
}
```

- `matchedFilter`：
  - `"unknown"`：列表项刚归一化、未与 matched 集合比对前。
  - `true` / `false`：在 `listMyOpen` 中由 `MY_OPEN_MATCHED_QUERY` 的结果集校准。
- `includedAsAncestor`：`!matchedFilter`，即作为父级上下文注入。
- `roots`：无 `parentId` 的项。
- `externalParentIds`：`parentId` 不在 `items` 中的项的父 id（去重）。
- `page.matchedCount` 优先取 matched 查询的 `preciseCount`，其次 `totalCount`，最后用 matched 集合 size。

## 12. 错误码 `TicketErrorCode`

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
```

详见 [11-error-handling.md](./11-error-handling.md)。

## 13. 脱敏策略 `TicketRedactionPolicy` / `redactTicket`

```ts
export interface TicketRedactionPolicy {
  omitPeople: boolean;
  removeFields: string[];
}

export function redactTicket(ticket: CanonicalTicket, policy: TicketRedactionPolicy): CanonicalTicket
```

行为（深拷贝后）：
1. `customFields` 过滤掉 `name` 或 `id`（小写 trim）命中 `removeFields` 集合的字段。
2. 若 `omitPeople`：删除 `assignee` / `reporter`，评论移除 `author`。
3. **无条件**删除每个附件的 `sourceUrl`（即使 `removeFields` 不包含）。

详见 [10-security-redaction.md](./10-security-redaction.md)。

## 14. 不变量速查

- `CanonicalTicket.schemaVersion` 恒为 `"1.0"`。
- `CanonicalTicket.source.provider` 当前恒为 `"ones"`，但类型为 `string`，预留多 provider。
- `CanonicalTicket.source.connector` ∈ `"graphql"` | `"browser"`，来自 profile.source。
- `TicketAttachment.sourceUrl` 在跨过 `redactTicket` 后**必然为 undefined**。
- `TicketInlineImage` 永不包含来源 URL。
- `InlineTicket.inline.truncated` 为 `false` 时，描述与所有保留评论均未截断。
- `TicketIndexTree.view` 恒为 `"my_open_tree"`（第一期唯一视图）。
