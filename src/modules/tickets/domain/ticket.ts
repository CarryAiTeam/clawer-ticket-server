export type TicketClass = "bugfix" | "feature" | "technical-change" | "unclassified";

export interface TicketReference {
  /** provider 为单个工单颁发的稳定标识。 */
  id: string;
}

export interface Person {
  id?: string;
  displayName?: string;
}

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

/** 在工单富文本中发现的、由 provider 颁发的图片引用。 */
export interface TicketInlineImage {
  /** 图片由附件资源承载时对应的 ONES 附件 UUID。 */
  attachmentId?: string;
  /** 可用时，从受控 ONES 附件路径解析出的稳定内容哈希。 */
  hash?: string;
  alt?: string;
  mediaType?: string;
  sizeHint?: string;
}

export interface TicketAttachment {
  id: string;
  name: string;
  mediaType?: string;
  sizeBytes?: number;
  hash?: string;
  sourceUrl?: string;
}

export interface TicketIteration {
  id: string;
  name: string;
  plannedStartAt?: string;
  plannedEndAt?: string;
}

export interface TicketRelation {
  type: "parent" | "child" | "related";
  targetId: string;
  targetKey?: string;
  title?: string;
}

export interface CanonicalTicket {
  schemaVersion: "1.0";
  source: {
    /** 来自所选 profile 的受控 provider 标识；v1 仅实现 ONES。 */
    provider: string;
    product: "project";
    tenantBaseUrl: string;
    teamId: string;
    /** 已授权接口返回项目标识时存在。 */
    projectId?: string;
    projectName?: string;
    ticketId: string;
    /** 来源返回时使用的 ONES GraphQL key，例如 task-<uuid>。 */
    ticketKey?: string;
    /** ONES 面向用户展示的工单编号。 */
    ticketNumber?: string;
    fetchedAt: string;
    connector: "graphql" | "browser";
  };
  classification: { value: TicketClass; matchedRule?: string; sourceValue?: string };
  title: string;
  descriptionMarkdown?: string;
  /** 描述富文本引用的图片，特意排除来源 URL。 */
  descriptionImages?: TicketInlineImage[];
  status?: string;
  priority?: string;
  /** ONES 自定义字段“严重程度”，用于辅助判断工单处置优先级。 */
  severity?: string;
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

/** 查询数据范围；默认只查询当前用户负责的工单。 */
export type TicketSearchScope = "self" | "project";

/** 查询状态范围；默认排除已完成工单。 */
export type TicketSearchState = "open" | "active" | "done" | "all";

/** 首版只允许由服务端编译的平铺 AND 条件，绝不接收 provider 原始筛选表达式。 */
export type TicketFilter =
  | { field: "title"; op: "contains"; value: string }
  | { field: "issueType"; op: "in"; values: string[] }
  | { field: "statusCategory"; op: "in" | "notIn"; values: TicketStatusCategory[] }
  | { field: "assignee"; op: "in"; values: ["me"] };

export type TicketStatusCategory = "to_do" | "in_progress" | "done";

/** MCP 公开搜索输入；profile 仍由受控本地配置解析。 */
export interface TicketSearchInput {
  profile?: string;
  scope?: TicketSearchScope;
  state?: TicketSearchState;
  where?: { all: TicketFilter[] };
  page?: { size?: number; cursor?: string };
}

/** 查询型导出的输入。展示状态名只用于完整枚举后的导出筛选，不影响列表分页契约。 */
export interface TicketExportSearchInput extends TicketSearchInput {
  statuses?: string[];
}

/** 应用层已验证的 provider-neutral 查询，不含公开 cursor 或 ONES variables。 */
export interface TicketSearchQuery {
  scope: TicketSearchScope;
  state: TicketSearchState;
  filter: { all: TicketFilter[] };
  sort: { field: "createTime"; direction: "desc" };
  page: { size: number; after?: string };
}

/** 列表检索只返回低成本的扁平摘要，详情必须显式调用 ticket_get。 */
export interface TicketSummary {
  id: string;
  key?: string;
  number?: string;
  title: string;
  status?: { id?: string; name?: string; category?: TicketStatusCategory };
  assignee?: Person;
  projectId?: string;
}

/** provider 返回内部续页信息；原始 endCursor 不会离开应用层。 */
export interface TicketSearchProviderPage {
  returned: number;
  totalCount: number;
  hasNextPage: boolean;
  endCursor?: string;
}

export interface TicketSearchProviderResult {
  items: TicketSummary[];
  page: TicketSearchProviderPage;
}

/** ticket_search 的稳定、对外结果；nextCursor 始终由本服务签发。 */
export interface TicketSearchResult {
  query: {
    scope: TicketSearchScope;
    state: TicketSearchState;
    normalizedFilter: { all: TicketFilter[] };
    fingerprint: string;
  };
  items: TicketSummary[];
  page: {
    size: number;
    returned: number;
    totalCount: number;
    totalCountExact: true;
    hasNextPage: boolean;
    nextCursor?: string;
  };
  warnings?: string[];
}

/** 查询型导出在 plan 阶段返回、并在 write 阶段必须回传的选择冻结。 */
export interface TicketSearchSelection {
  expectedCount: number;
  fingerprint: string;
}
