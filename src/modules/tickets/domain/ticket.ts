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
    /** 树中的所有行，包括为补充上下文而注入的父级行。 */
    count: number;
    /** 匹配“当前用户 + 未完成”固定筛选条件的行。 */
    matchedCount: number;
    /** 未匹配固定筛选条件的树上下文行。 */
    contextCount: number;
    totalCount?: number;
    hasNextPage: boolean;
  };
}
