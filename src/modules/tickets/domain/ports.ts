import { CanonicalTicket, TicketAttachment, TicketReference, TicketSearchProviderResult, TicketSearchQuery } from "./ticket.js";

/** 受控本地工单 profile 中与 provider 无关的部分。 */
export interface TicketProfile {
  name: string;
  providerId: string;
  connector: string;
  allowedProjects: string[];
  inlineMaxChars: number;
}

export interface TicketProfileResolver {
  get(name: string): TicketProfile;
  /** 显式名称优先；仅配置一个 profile 时允许省略名称。 */
  resolve(name?: string): TicketProfile;
}

export interface ConnectionStatus {
  configured: boolean;
  authorized: boolean;
  diagnostics: string[];
  credentialAvailable?: boolean;
}

/** provider 返回已校验的规范数据；原始厂商接口不跨越此边界。 */
export interface TicketProvider {
  readonly providerId: string;
  status(profile: TicketProfile): Promise<ConnectionStatus>;
  /** 只接受应用层规范化后的查询；provider 原始表达式不属于此 port。 */
  search(profile: TicketProfile, query: TicketSearchQuery): Promise<TicketSearchProviderResult>;
  getTicket(profile: TicketProfile, reference: TicketReference): Promise<CanonicalTicket>;
}

/** 二进制内容不进入 MCP 响应，只流向本地导出存储。 */
export interface TicketMediaDownload {
  attachment: TicketAttachment;
  bytes: Uint8Array;
  contentType?: string;
}

/** 显式能力边界：读取工单元数据不等于下载二进制媒体。 */
export interface TicketMediaProvider {
  downloadAttachment(profile: TicketProfile, attachment: TicketAttachment): Promise<TicketMediaDownload>;
}

export type TicketMediaMode = "metadata" | "download";

export interface TicketMediaPlan {
  attachment: TicketAttachment;
  roles: Array<"attachment" | "description-image" | "comment-image">;
  path: string;
}

/** 事务型本地导出会话：beginExport 暂存已有媒体，应用层补齐缺失媒体。 */
export interface TicketExportWriteSession {
  readonly missingMedia: readonly TicketMediaPlan[];
  writeMedia(plan: TicketMediaPlan, download: TicketMediaDownload): Promise<void>;
  commit(): Promise<ExportResult>;
  abort(): Promise<void>;
}

export interface BrowserSessionStatus {
  url: string;
  message: string;
  authentication: {
    mode: "auto" | "manual";
    authorized: boolean;
    diagnostics: string[];
  };
}

/** 可选的受监督能力；刻意与工单读取能力分离。 */
export interface BrowserSessionProvider {
  openBrowserSession(profile: TicketProfile): Promise<BrowserSessionStatus>;
  closeBrowserSession(profile: TicketProfile): Promise<void>;
}

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

export interface TicketBundleStore {
  plan(ticket: CanonicalTicket, media?: TicketMediaPlan[]): Promise<ExportPlan>;
  beginExport(ticket: CanonicalTicket, media?: TicketMediaPlan[]): Promise<TicketExportWriteSession>;
}
