import {
  CanonicalTicket,
  InlineTicket,
  TicketReference,
  TicketSearchInput,
  TicketSearchProviderPage,
  TicketSearchProviderResult,
  TicketSearchQuery,
  TicketSearchResult,
  TicketSearchSelection,
  TicketSummary,
} from "../domain/ticket.js";
import { TicketError } from "../domain/ticket-error.js";
import { BrowserSessionProvider, ExportPlan, ExportResult, TicketBundleStore, TicketMediaMode, TicketMediaPlan, TicketMediaProvider, TicketProfile, TicketProfileResolver, TicketProvider } from "../domain/ports.js";
import { redactTicket, redactTicketSummary, TicketRedactionPolicy } from "../domain/ticket-policy.js";
import {
  normalizeTicketSearchInput,
  TicketSearchCursorStore,
  ticketSearchFingerprint,
  ticketSelectionFingerprint,
  validateSelection,
} from "../domain/ticket-search.js";

export interface TicketApplicationDependencies {
  profiles: TicketProfileResolver;
  provider: TicketProvider;
  bundleStore: TicketBundleStore;
  redaction: TicketRedactionPolicy;
  browserSessions?: BrowserSessionProvider;
  mediaProvider?: TicketMediaProvider;
  /** 可注入以便验证 cursor 过期等纯应用层行为；默认只保存在当前服务进程。 */
  cursorStore?: TicketSearchCursorStore;
  /** 查询型导出防止意外枚举无限结果集的受控上限。 */
  maxSearchExportItems?: number;
}

export interface TicketSearchExportResult {
  query: TicketSearchResult["query"];
  selection: TicketSearchSelection;
  selectedCount: number;
  complete: true;
  exports: Array<ExportPlan | ExportResult>;
}

export class TicketApplication {
  private readonly cursors: TicketSearchCursorStore;
  private readonly maxSearchExportItems: number;

  /** 保存由组合根注入的 profile、provider、存储与安全策略依赖。 */
  constructor(private readonly dependencies: TicketApplicationDependencies) {
    this.cursors = dependencies.cursorStore ?? new TicketSearchCursorStore();
    this.maxSearchExportItems = dependencies.maxSearchExportItems ?? 10_000;
  }

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

  /**
   * 执行受控的扁平工单检索。公共 cursor 只在本层解封装，provider 永远只看到
   * 经绑定校验后的内部 after 值和固定排序。
   */
  async searchTickets(input: TicketSearchInput): Promise<TicketSearchResult> {
    const resolved = this.resolveSearch(input);
    let query = resolved.query;
    if (resolved.cursor) {
      query = {
        ...query,
        page: {
          ...query.page,
          after: this.cursors.resolve(resolved.cursor, {
            profile: resolved.profile.name,
            fingerprint: resolved.fingerprint,
            pageSize: query.page.size,
          }),
        },
      };
    }
    const providerResult = await this.dependencies.provider.search(resolved.profile, query);
    const page = this.validatedSearchPage(providerResult, query);
    this.assertSearchProjectScope(resolved.profile, providerResult.items);
    const items = providerResult.items.map((item) => redactTicketSummary(item, this.dependencies.redaction));
    const nextCursor = page.hasNextPage
      ? this.cursors.issue(page.endCursor!, {
        profile: resolved.profile.name,
        fingerprint: resolved.fingerprint,
        pageSize: query.page.size,
      })
      : undefined;
    return {
      query: {
        preset: query.preset,
        normalizedFilter: query.filter,
        fingerprint: resolved.fingerprint,
      },
      items,
      page: {
        size: query.page.size,
        returned: page.returned,
        totalCount: page.totalCount,
        totalCountExact: true,
        hasNextPage: page.hasNextPage,
        ...(nextCursor ? { nextCursor } : {}),
      },
    };
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
    return this.exportLoadedTicket(profile, ticket, mode, mediaMode);
  }

  /**
   * 对一个完整受控查询执行导出。plan 阶段返回有序 ID 集合的 fingerprint；write 阶段
   * 必须回传它，服务会重新完整枚举并在集合变化时拒绝写入。
   */
  async exportTicketSearch(
    profile: string | undefined,
    input: TicketSearchInput,
    mode: "plan" | "write",
    mediaMode: TicketMediaMode = "download",
    selection?: TicketSearchSelection,
  ): Promise<TicketSearchExportResult> {
    if (input.page !== undefined) {
      throw new TicketError("QUERY_INVALID", "ticket_export query does not accept page; it always enumerates the complete selection");
    }
    const resolved = this.resolveSearch({ ...input, ...(profile ? { profile } : {}) });
    if (resolved.cursor) throw new TicketError("QUERY_INVALID", "ticket_export query does not accept page.cursor");
    const summaries = await this.enumerateSearch(resolved.profile, resolved.query);
    const frozenSelection = {
      expectedCount: summaries.length,
      fingerprint: ticketSelectionFingerprint(resolved.fingerprint, summaries.map((item) => item.id)),
    };
    if (mode === "write") {
      if (!selection) {
        throw new TicketError("QUERY_INVALID", "ticket_export mode write for a query requires the selection returned by a prior plan");
      }
      const expected = validateSelection(selection);
      if (expected.expectedCount !== frozenSelection.expectedCount || expected.fingerprint !== frozenSelection.fingerprint) {
        throw new TicketError("SELECTION_CHANGED", "The query selection changed after plan; run ticket_export with mode plan again before writing");
      }
    }
    // 详情读取是查询型导出的最后一道完整性闸门：任一详情失败时尚未开始本地写入。
    const tickets: CanonicalTicket[] = [];
    for (const item of summaries) {
      tickets.push(await this.getTicket(resolved.profile.name, { id: item.id }));
    }
    const exports: Array<ExportPlan | ExportResult> = [];
    for (const ticket of tickets) {
      exports.push(await this.exportLoadedTicket(resolved.profile.name, ticket, mode, mediaMode));
    }
    return {
      query: { preset: resolved.query.preset, normalizedFilter: resolved.query.filter, fingerprint: resolved.fingerprint },
      selection: frozenSelection,
      selectedCount: summaries.length,
      complete: true,
      exports,
    };
  }

  /** 复用单项导出的完整详情和受控媒体写入逻辑。 */
  private async exportLoadedTicket(profile: string | undefined, ticket: CanonicalTicket, mode: "plan" | "write", mediaMode: TicketMediaMode): Promise<ExportPlan | ExportResult> {
    const media = mediaMode === "download" ? this.mediaPlan(ticket) : [];
    if (mode === "plan") return this.dependencies.bundleStore.plan(ticket, media);
    return this.downloadMissingMedia(profile, ticket, media);
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

  /** 先在应用层规范化查询，再把 profile 和 page size 绑定到公共 cursor。 */
  private resolveSearch(input: TicketSearchInput) {
    const normalized = normalizeTicketSearchInput(input);
    const profile = this.profile(normalized.profile);
    const fingerprint = ticketSearchFingerprint(profile.name, normalized.query);
    return { profile, query: normalized.query, fingerprint, cursor: normalized.cursor };
  }

  /** 即使 provider 实现被替换，profile 项目范围仍由应用层最终兜底。 */
  private assertSearchProjectScope(profile: TicketProfile, items: readonly TicketSummary[]): void {
    if (profile.allowedProjects.length === 0) return;
    for (const item of items) {
      if (!item.projectId || !profile.allowedProjects.includes(item.projectId)) {
        throw new TicketError("SOURCE_NOT_ALLOWED", "Ticket search returned an item outside the profile project allowlist");
      }
    }
  }

  /** 不信任 provider 的分页元数据；异常形状不会被包装为看似完整的搜索结果。 */
  private validatedSearchPage(result: TicketSearchProviderResult, _query: TicketSearchQuery): TicketSearchProviderPage {
    if (!result || !Array.isArray(result.items) || !result.page) {
      throw new TicketError("SOURCE_SCHEMA_CHANGED", "Ticket search provider returned an invalid result");
    }
    for (const item of result.items) {
      if (!item || typeof item.id !== "string" || !item.id.trim() || typeof item.title !== "string") {
        throw new TicketError("SOURCE_SCHEMA_CHANGED", "Ticket search provider returned an invalid summary item");
      }
    }
    const page = result.page;
    if (!Number.isSafeInteger(page.returned) || page.returned < 0 || page.returned !== result.items.length) {
      throw new TicketError("SOURCE_SCHEMA_CHANGED", "Ticket search provider returned an inconsistent page count");
    }
    if (!Number.isSafeInteger(page.totalCount) || page.totalCount < page.returned) {
      throw new TicketError("SOURCE_SCHEMA_CHANGED", "Ticket search provider returned an invalid total count");
    }
    if (typeof page.hasNextPage !== "boolean") {
      throw new TicketError("SOURCE_SCHEMA_CHANGED", "Ticket search provider returned an invalid continuation flag");
    }
    if (page.hasNextPage && (!page.endCursor || typeof page.endCursor !== "string")) {
      throw new TicketError("SOURCE_SCHEMA_CHANGED", "Ticket search provider reported another page without an end cursor");
    }
    return page;
  }

  /** 完整枚举查询型导出所需的全部摘要；总数变化、重复 ID 和未完成页都会拒绝。 */
  private async enumerateSearch(profile: TicketProfile, baseQuery: TicketSearchQuery): Promise<TicketSummary[]> {
    const summaries: TicketSummary[] = [];
    const ids = new Set<string>();
    let after: string | undefined;
    let expectedTotal: number | undefined;
    for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
      const query: TicketSearchQuery = {
        ...baseQuery,
        page: { size: 50, ...(after ? { after } : {}) },
      };
      const response = await this.dependencies.provider.search(profile, query);
      const page = this.validatedSearchPage(response, query);
      this.assertSearchProjectScope(profile, response.items);
      if (expectedTotal === undefined) expectedTotal = page.totalCount;
      else if (expectedTotal !== page.totalCount) {
        throw new TicketError("SOURCE_INCOMPLETE", "Ticket search total changed while preparing the export selection");
      }
      if (page.totalCount > this.maxSearchExportItems) {
        throw new TicketError("SOURCE_INCOMPLETE", `Ticket search matches more than the configured export limit of ${this.maxSearchExportItems}`);
      }
      for (const item of response.items) {
        if (ids.has(item.id)) throw new TicketError("SOURCE_SCHEMA_CHANGED", "Ticket search provider returned a duplicate item across pages");
        ids.add(item.id);
        summaries.push(item);
      }
      if (summaries.length > this.maxSearchExportItems) {
        throw new TicketError("SOURCE_INCOMPLETE", `Ticket search exceeds the configured export limit of ${this.maxSearchExportItems}`);
      }
      if (!page.hasNextPage) {
        if (summaries.length !== page.totalCount) {
          throw new TicketError("SOURCE_INCOMPLETE", "Ticket search did not enumerate every matching work item for export");
        }
        return summaries;
      }
      after = page.endCursor;
    }
    throw new TicketError("SOURCE_INCOMPLETE", "Ticket search exceeded the maximum number of export pages");
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
