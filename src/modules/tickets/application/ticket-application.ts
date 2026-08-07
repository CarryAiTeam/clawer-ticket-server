import { CanonicalTicket, InlineTicket, TicketReference } from "../domain/ticket.js";
import { TicketError } from "../domain/ticket-error.js";
import { BrowserSessionProvider, ExportPlan, ExportResult, TicketBundleStore, TicketMediaMode, TicketMediaPlan, TicketMediaProvider, TicketProfile, TicketProfileResolver, TicketProvider } from "../domain/ports.js";
import { redactTicket, TicketRedactionPolicy } from "../domain/ticket-policy.js";

export interface TicketApplicationDependencies {
  profiles: TicketProfileResolver;
  provider: TicketProvider;
  bundleStore: TicketBundleStore;
  redaction: TicketRedactionPolicy;
  browserSessions?: BrowserSessionProvider;
  mediaProvider?: TicketMediaProvider;
}

export class TicketApplication {
  /** 保存由组合根注入的 profile、provider、存储与安全策略依赖。 */
  constructor(private readonly dependencies: TicketApplicationDependencies) {}

  /** 查询 profile 的连接状态，并返回受控的 provider 与项目范围信息。 */
  async connectionStatus(profile?: string) {
    const selectedProfile = this.profile(profile);
    const status = await this.dependencies.provider.status(selectedProfile);
    return { profile: selectedProfile.name, provider: selectedProfile.providerId, connector: selectedProfile.connector, allowedProjects: selectedProfile.allowedProjects, ...status };
  }

  /** 打开指定 profile 的受监督浏览器会话。 */
  async openBrowserSession(profile?: string) {
    return this.browserSessions().openBrowserSession(this.profile(profile));
  }

  /** 关闭指定 profile 的受监督浏览器会话并清理内存登录态。 */
  async closeBrowserSession(profile?: string): Promise<void> {
    await this.browserSessions().closeBrowserSession(this.profile(profile));
  }

  /** 读取当前用户未完成工单的树形索引，不获取详情。 */
  async listMyOpen(profile: string | undefined, limit: number) {
    return this.dependencies.provider.listMyOpen(this.profile(profile), limit);
  }

  /** 逐条读取匹配工单的完整详情；任何一条不完整都会整体失败，绝不以列表摘要代替详情。 */
  async listMyOpenDetails(profile: string | undefined, limit: number) {
    const index = await this.listMyOpen(profile, limit);
    if (index.page.hasNextPage) {
      throw new TicketError("SOURCE_INCOMPLETE", "The requested limit does not cover every matching work item; increase limit before requesting details");
    }
    const matches = index.items.filter((item) => item.matchedFilter === true);
    if (matches.length !== index.page.matchedCount) {
      throw new TicketError(
        "SOURCE_INCOMPLETE",
        `Provider reported ${index.page.matchedCount} matching work items but enumerated ${matches.length}; details were not partially returned`,
      );
    }
    const tickets: CanonicalTicket[] = [];
    for (const item of matches) tickets.push(await this.getTicket(profile, { id: item.id }));
    return { ...index, tickets, detailCount: tickets.length, complete: true as const };
  }

  /** 获取一张已归一化、通过项目范围校验且完成脱敏的工单。 */
  async getTicket(profile: string | undefined, reference: TicketReference): Promise<CanonicalTicket> {
    const selectedProfile = this.profile(profile);
    const ticket = await this.dependencies.provider.getTicket(selectedProfile, reference);
    if (selectedProfile.allowedProjects.length > 0 && (!ticket.source.projectId || !selectedProfile.allowedProjects.includes(ticket.source.projectId))) {
      throw new TicketError("SOURCE_NOT_ALLOWED", "Ticket project is outside the profile allowlist");
    }
    return redactTicket(ticket, this.dependencies.redaction);
  }

  /** 获取适合 MCP 内联返回的工单详情，并限制正文体积。 */
  async getTicketInline(profile: string | undefined, reference: TicketReference): Promise<InlineTicket> {
    const selectedProfile = this.profile(profile);
    return projectTicketForInline(await this.getTicket(selectedProfile.name, reference), selectedProfile.inlineMaxChars);
  }

  /** 为单张工单生成导出计划或显式写入本地 bundle；默认下载媒体，metadata 可关闭下载。 */
  async exportTicket(profile: string | undefined, reference: TicketReference, mode: "plan" | "write", mediaMode: TicketMediaMode = "download"): Promise<ExportPlan | ExportResult> {
    const ticket = await this.getTicket(profile, reference);
    const media = mediaMode === "download" ? this.mediaPlan(ticket) : [];
    if (mode === "plan") return this.dependencies.bundleStore.plan(ticket, media);
    return this.downloadMissingMedia(profile, ticket, media);
  }

  /** 先读取全部详情再批量导出，避免失败时落盘不完整的摘要数据。 */
  async exportMyOpenTickets(profile: string | undefined, limit: number, mode: "plan" | "write", mediaMode: TicketMediaMode = "download", statuses?: string[]) {
    const detailed = await this.listMyOpenDetailsForExport(profile, limit, statuses);
    const exports: Array<ExportPlan | ExportResult> = [];
    for (const ticket of detailed.tickets) {
      const media = mediaMode === "download" ? this.mediaPlan(ticket) : [];
      if (mode === "plan") exports.push(await this.dependencies.bundleStore.plan(ticket, media));
      else exports.push(await this.downloadMissingMedia(profile, ticket, media));
    }
    return {
      matchedCount: detailed.page.matchedCount,
      selectedCount: detailed.tickets.length,
      detailCount: detailed.detailCount,
      complete: detailed.complete,
      exports,
    };
  }

  /** 仅读取指定状态的详情；未提供筛选时保留“全部未完成”的默认行为。 */
  private async listMyOpenDetailsForExport(profile: string | undefined, limit: number, statuses?: string[]) {
    const index = await this.listMyOpen(profile, limit);
    if (index.page.hasNextPage) {
      throw new TicketError("SOURCE_INCOMPLETE", "The requested limit does not cover every matching work item; increase limit before exporting");
    }
    const expected = index.items.filter((item) => item.matchedFilter === true);
    if (expected.length !== index.page.matchedCount) {
      throw new TicketError("SOURCE_INCOMPLETE", `Provider reported ${index.page.matchedCount} matching work items but enumerated ${expected.length}; export was not started`);
    }
    const selectedStatuses = statuses?.map((value) => value.trim()).filter(Boolean);
    const selected = selectedStatuses?.length
      ? expected.filter((item) => item.status && selectedStatuses.includes(item.status))
      : expected;
    const tickets: CanonicalTicket[] = [];
    for (const item of selected) tickets.push(await this.getTicket(profile, { id: item.id }));
    return { ...index, tickets, detailCount: tickets.length, complete: true as const };
  }

  /** 已验证媒体只暂存一次；仅将缺失文件下载到同一原子导出会话。 */
  private async downloadMissingMedia(profile: string | undefined, ticket: CanonicalTicket, media: TicketMediaPlan[]): Promise<ExportResult> {
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

  /** 先按附件 UUID、再按声明的内容哈希去重；内联图片只保留逻辑角色。 */
  private mediaPlan(ticket: CanonicalTicket): TicketMediaPlan[] {
    const byIdentity = new Map<string, TicketMediaPlan>();
    const add = (attachment: CanonicalTicket["attachments"][number], role: TicketMediaPlan["roles"][number]) => {
      const identity = attachment.hash ? `hash:${attachment.hash}` : `id:${attachment.id}`;
      const existing = byIdentity.get(identity);
      if (existing) { if (!existing.roles.includes(role)) existing.roles.push(role); return; }
      const refs = [
        ...(ticket.descriptionImages ?? []),
        ...ticket.comments.flatMap((comment) => comment.images ?? []),
      ];
      const embedded = refs.some((image) => image.attachmentId === attachment.id || (image.hash && image.hash === attachment.hash));
      const primary = embedded && (ticket.descriptionImages ?? []).some((image) => image.attachmentId === attachment.id || (image.hash && image.hash === attachment.hash))
        ? "assets/description" : embedded ? "assets/comments" : "attachments";
      byIdentity.set(identity, { attachment, roles: [role], path: `${primary}/${attachment.id}-${safeMediaName(attachment.name)}` });
    };
    for (const attachment of ticket.attachments) add(attachment, "attachment");
    for (const image of ticket.descriptionImages ?? []) {
      const attachment = ticket.attachments.find((item) => item.id === image.attachmentId || (image.hash && item.hash === image.hash));
      if (attachment) add(attachment, "description-image");
    }
    for (const comment of ticket.comments) for (const image of comment.images ?? []) {
      const attachment = ticket.attachments.find((item) => item.id === image.attachmentId || (image.hash && item.hash === image.hash));
      if (attachment) add(attachment, "comment-image");
    }
    return [...byIdentity.values()];
  }

  /** 解析并校验 profile 与当前注入 provider 是否匹配。 */
  private profile(name?: string): TicketProfile {
    const profile = this.dependencies.profiles.resolve(name);
    if (profile.providerId !== this.dependencies.provider.providerId) {
      throw new TicketError("PROVIDER_NOT_AVAILABLE", `Profile ${profile.name} requires provider ${profile.providerId}, but ${this.dependencies.provider.providerId} is configured`);
    }
    return profile;
  }

  /** 获取可选浏览器能力；未配置时给出明确的可操作错误。 */
  private browserSessions(): BrowserSessionProvider {
    if (!this.dependencies.browserSessions) {
      throw new TicketError("CONFIG_INVALID", "The configured ticket source does not support supervised browser sessions");
    }
    return this.dependencies.browserSessions;
  }

  private mediaProvider(): TicketMediaProvider {
    if (!this.dependencies.mediaProvider) throw new TicketError("CONFIG_INVALID", "The configured ticket source does not support controlled media downloads");
    return this.dependencies.mediaProvider;
  }
}

function safeMediaName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 120) || "unnamed";
}

/** 按字符预算截断文本，并保留截断统计信息。 */
function clip(value: string, maxChars: number): { value: string; consumed: number; truncated: boolean } {
  if (value.length <= maxChars) return { value, consumed: value.length, truncated: false };
  if (maxChars <= 1) return { value: "…", consumed: 0, truncated: true };
  return { value: `${value.slice(0, maxChars - 1)}…`, consumed: maxChars, truncated: true };
}

/** 将完整工单裁剪为有内容预算的 MCP 内联响应；导出始终使用完整工单。 */
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
  const comments = [] as CanonicalTicket["comments"];
  for (const comment of ticket.comments) {
    if (remaining <= 0 || comments.length >= maxMetadataItems) {
      omittedCommentCount += 1;
      truncated = true;
      continue;
    }
    const body = clip(comment.bodyMarkdown, Math.min(2_000, remaining));
    remaining -= body.consumed;
    truncated ||= body.truncated;
    comments.push({ ...comment, bodyMarkdown: body.value });
  }
  return {
    ...ticket,
    ...(description ? { descriptionMarkdown: description.value } : {}),
    comments,
    attachments: ticket.attachments.slice(0, maxMetadataItems),
    relations: ticket.relations.slice(0, maxMetadataItems),
    customFields: ticket.customFields.slice(0, maxMetadataItems),
    inline: {
      contentLimit,
      contentChars: contentLimit - remaining,
      truncated: truncated || omittedAttachmentCount > 0 || omittedRelationCount > 0 || omittedCustomFieldCount > 0,
      omittedCommentCount,
      omittedAttachmentCount,
      omittedRelationCount,
      omittedCustomFieldCount,
    },
  };
}
