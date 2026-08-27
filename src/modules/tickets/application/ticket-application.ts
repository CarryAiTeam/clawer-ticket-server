import {
  CanonicalTicket,
  InlineTicket,
  TicketExportSearchInput,
  TicketReference,
  TicketSearchInput,
  TicketSearchProviderPage,
  TicketSearchProviderResult,
  TicketSearchQuery,
  TicketSearchResult,
  TicketSearchSelection,
  TicketSummary,
} from "../domain/ticket.js";
import { TicketError, TicketErrorCode } from "../domain/ticket-error.js";
import {
  assertDownloadedBytes,
  assertMediaSummaryWithinLimits,
  assertMediaWithinLimits,
  mergeMediaSummaries,
  normalizeTicketExportLimits,
  TicketExportBudgetReport,
  TicketExportLimits,
  TicketExportMediaSummary,
  TicketSearchExportBudgetReport,
} from "../domain/ticket-export.js";
import { BrowserSessionProvider, ExportPlan, ExportResult, TicketBundleStore, TicketMediaMode, TicketMediaPlan, TicketMediaProvider, TicketProfile, TicketProfileResolver, TicketProvider } from "../domain/ports.js";
import { redactTicket, redactTicketSummary, TicketRedactionPolicy } from "../domain/ticket-policy.js";
import {
  normalizeTicketSearchInput,
  normalizeTicketExportSearchInput,
  TicketSearchCursorStore,
  ticketExportSearchFingerprint,
  ticketSearchFingerprint,
  ticketSelectionFingerprint,
  validateSelection,
} from "../domain/ticket-search.js";
import { runBoundedWorkerPool, WorkerPoolResult } from "./bounded-worker-pool.js";

export interface TicketApplicationDependencies {
  profiles: TicketProfileResolver;
  provider: TicketProvider;
  bundleStore: TicketBundleStore;
  redaction: TicketRedactionPolicy;
  browserSessions?: BrowserSessionProvider;
  mediaProvider?: TicketMediaProvider;
  /** 可注入以便验证 cursor 过期等纯应用层行为；默认只保存在当前服务进程。 */
  cursorStore?: TicketSearchCursorStore;
  /** 本地导出数量与媒体大小的服务端硬预算。 */
  exportLimits?: Partial<TicketExportLimits>;
}

export type TicketExportArtifact = (ExportPlan | ExportResult) & { budget: TicketExportBudgetReport };

export interface TicketSearchExportFailure {
  ticketId: string;
  code: TicketErrorCode | "UNEXPECTED";
  message: string;
}

export interface TicketSearchExportResult {
  query: TicketSearchResult["query"];
  selection: TicketSearchSelection;
  selectedCount: number;
  completedCount: number;
  complete: boolean;
  exports: TicketExportArtifact[];
  failedTickets: TicketSearchExportFailure[];
  completedTickets: Array<{ ticketId: string; completionIndex: number }>;
  budget: TicketSearchExportBudgetReport;
}

interface MutableExportUsage {
  attachmentCount: number;
  plannedMedia: TicketExportMediaSummary;
  downloadedBytes: number;
}

type ExportWorkerOutcome =
  | { ticketId: string; artifact: TicketExportArtifact }
  | { ticketId: string; failure: TicketSearchExportFailure };

function hasExportArtifact(
  entry: WorkerPoolResult<ExportWorkerOutcome>,
): entry is WorkerPoolResult<{ ticketId: string; artifact: TicketExportArtifact }> {
  return "artifact" in entry.value;
}

function hasExportFailure(
  entry: WorkerPoolResult<ExportWorkerOutcome>,
): entry is WorkerPoolResult<{ ticketId: string; failure: TicketSearchExportFailure }> {
  return "failure" in entry.value;
}

/** 串行化汇总预算预留，保证各工位的工单处理流程可以彼此独立。 */
class ExportUsageLedger {
  private usage: MutableExportUsage = { attachmentCount: 0, plannedMedia: emptyMediaSummary(), downloadedBytes: 0 };

  reserve(ticket: CanonicalTicket, media: readonly TicketMediaPlan[], limits: TicketExportLimits): MutableExportUsage {
    const next = {
      attachmentCount: this.usage.attachmentCount + ticket.attachments.length,
      plannedMedia: mergeMediaSummaries(this.usage.plannedMedia, summarizeMedia(media)),
      downloadedBytes: this.usage.downloadedBytes,
    };
    if (next.attachmentCount > limits.maxAttachments) throw new TicketError("EXPORT_LIMIT_EXCEEDED", `Export contains ${next.attachmentCount} attachments; the configured limit is ${limits.maxAttachments}`);
    assertMediaSummaryWithinLimits(next.plannedMedia, limits);
    this.usage = next;
    return this.snapshot();
  }

  addDownloaded(bytes: Uint8Array, attachment: CanonicalTicket["attachments"][number], limits: TicketExportLimits): void {
    this.usage.downloadedBytes = assertDownloadedBytes(bytes, attachment, this.usage.downloadedBytes, limits);
  }

  snapshot(): MutableExportUsage {
    return { attachmentCount: this.usage.attachmentCount, plannedMedia: { ...this.usage.plannedMedia }, downloadedBytes: this.usage.downloadedBytes };
  }
}

function emptyMediaSummary(): TicketExportMediaSummary {
  return { plannedCount: 0, knownBytes: 0, unknownSizeCount: 0 };
}

function summarizeMedia(media: readonly TicketMediaPlan[]): TicketExportMediaSummary {
  let knownBytes = 0;
  let unknownSizeCount = 0;
  for (const item of media) {
    const size = item.attachment.sizeBytes;
    if (typeof size === "number" && Number.isSafeInteger(size) && size >= 0) knownBytes += size;
    else unknownSizeCount += 1;
  }
  return { plannedCount: media.length, knownBytes, unknownSizeCount };
}

function exportFailure(ticketId: string, error: unknown): TicketSearchExportFailure {
  if (error instanceof TicketError) return { ticketId, code: error.code, message: error.message };
  return { ticketId, code: "UNEXPECTED", message: "Ticket export failed unexpectedly" };
}

export class TicketApplication {
  private readonly cursors: TicketSearchCursorStore;
  private readonly exportLimits: TicketExportLimits;

  /** 保存由组合根注入的 profile、provider、存储与安全策略依赖。 */
  constructor(private readonly dependencies: TicketApplicationDependencies) {
    this.cursors = dependencies.cursorStore ?? new TicketSearchCursorStore();
    this.exportLimits = normalizeTicketExportLimits(dependencies.exportLimits);
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
   * 对授权失败的浏览器请求只恢复一次。
   * 仅清理本次调用实际创建的浏览器；调用方显式创建的会话保留给 MFA 等人工操作。
   */
  async withBrowserAuthRecovery<T>(profile: string | undefined, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.throwIfAborted(signal);
    try {
      return await operation();
    } catch (error) {
      if (!this.isAuthorizationError(error)) throw error;
    }
    const selected = this.profile(profile);
    const session = await this.browserSessions().openBrowserSession(selected);
    if (!session.authentication.authorized) {
      const authorizationState = session.authentication.state ?? "manual-action-required";
      if (authorizationState === "pending") {
        throw new TicketError(
          "AUTHORIZATION_PENDING",
          "ONES automatic sign-in was submitted, but browser authorization is still pending. Keep the visible browser session open and retry the same ticket operation shortly.",
          { authorizationState: "pending", diagnostics: session.authentication.diagnostics },
        );
      }
      throw new TicketError(
        "HUMAN_ACTION_REQUIRED",
        "ONES requires an action in the visible browser session before retrying.",
        { authorizationState: "manual-action-required", diagnostics: session.authentication.diagnostics },
      );
    }
    try {
      this.throwIfAborted(signal);
      return await operation();
    } finally {
      if (session.created) await this.browserSessions().closeBrowserSession(selected).catch(() => undefined);
    }
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
        scope: query.scope,
        state: query.state,
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
  async exportTicket(profile: string | undefined, reference: TicketReference, mode: "plan" | "write", mediaMode: TicketMediaMode = "download"): Promise<TicketExportArtifact> {
    const ticket = await this.getTicket(profile, reference);
    return this.exportLoadedTicket(profile, ticket, mode, mediaMode);
  }

  /**
   * 对一个完整受控查询执行导出。plan 阶段返回有序 ID 集合的 fingerprint；直接 write
   * 在同一调用中使用当前选择；大范围 write 先返回冻结选择，带此前 selection
   * 的 write 则重新枚举并拒绝集合、查询或媒体模式变化。
   */
  async exportTicketSearch(
    profile: string | undefined,
    input: TicketExportSearchInput,
    mode: "plan" | "write",
    mediaMode: TicketMediaMode = "download",
    selection?: TicketSearchSelection,
    signal?: AbortSignal,
  ): Promise<TicketSearchExportResult> {
    if (input.page !== undefined) {
      throw new TicketError("QUERY_INVALID", "ticket_export query does not accept page; it always enumerates the complete selection");
    }
    const resolved = this.resolveExportSearch({ ...input, ...(profile ? { profile } : {}) });
    if (resolved.cursor) throw new TicketError("QUERY_INVALID", "ticket_export query does not accept page.cursor");
    const enumerated = await this.enumerateSearch(resolved.profile, resolved.query);
    const summaries = resolved.statuses.length === 0
      ? enumerated
      : enumerated.filter((item) => item.status?.name !== undefined && resolved.statuses.includes(item.status.name));
    const frozenSelection = {
      expectedCount: summaries.length,
      fingerprint: ticketSelectionFingerprint(`${resolved.fingerprint}:${mediaMode}`, summaries.map((item) => item.id)),
    };
    if (mode === "write" && selection) {
      const expected = validateSelection(selection);
      if (expected.expectedCount !== frozenSelection.expectedCount || expected.fingerprint !== frozenSelection.fingerprint) {
        throw new TicketError("SELECTION_CHANGED", "The query selection changed after plan; run ticket_export with mode plan again before writing");
      }
    } else if (mode === "write" && summaries.length > this.exportLimits.autoDownloadThreshold) {
      throw new TicketError(
        "EXPORT_CONFIRMATION_REQUIRED",
        `Ticket search matches ${summaries.length} items. Confirm the frozen selection before writing the complete export.`,
        {
          confirmation: {
            selectedCount: summaries.length,
            autoDownloadThreshold: this.exportLimits.autoDownloadThreshold,
            maxItems: this.exportLimits.maxItems,
            selection: frozenSelection,
            query: {
              scope: resolved.query.scope,
              state: resolved.query.state,
              fingerprint: resolved.fingerprint,
              mediaMode,
            },
          },
        },
      );
    }
    // 每张详情只在处理该张导出时保留，避免大查询把完整工单全文全部驻留内存。
    const usage = this.emptyExportUsage();
    const ledger = new ExportUsageLedger();
    const workerCount = mode === "plan" ? 1 : Math.min(3, resolved.profile.maxConcurrent ?? 1);
    const handled = await runBoundedWorkerPool<TicketSummary, ExportWorkerOutcome>(summaries, workerCount, async (item) => {
      try {
        this.throwIfAborted(signal);
        const ticket = await this.getTicket(resolved.profile.name, { id: item.id });
        return { ticketId: item.id, artifact: await this.exportLoadedTicket(resolved.profile.name, ticket, mode, mediaMode, mode === "write" ? undefined : usage, mode === "write" ? ledger : undefined) } as const;
      } catch (error) {
        if (error instanceof TicketError && error.code === "REQUEST_CANCELLED") throw error;
        if (this.isAuthorizationError(error)) throw error;
        if (mode === "plan") throw error;
        return { ticketId: item.id, failure: exportFailure(item.id, error) } as const;
      }
    }, signal);
    this.throwIfAborted(signal);
    const exports = handled
      .filter(hasExportArtifact)
      .sort((left, right) => left.inputIndex - right.inputIndex)
      .map((entry) => entry.value.artifact);
    const failedTickets = handled
      .filter(hasExportFailure)
      .sort((left, right) => left.inputIndex - right.inputIndex)
      .map((entry) => entry.value.failure);
    const completedTickets = handled
      .filter(hasExportArtifact)
      .sort((left, right) => left.completionIndex - right.completionIndex)
      .map((entry) => ({ ticketId: entry.value.ticketId, completionIndex: entry.completionIndex }));
    return {
      query: {
        scope: resolved.query.scope,
        state: resolved.query.state,
        normalizedFilter: resolved.query.filter,
        fingerprint: resolved.fingerprint,
      },
      selection: frozenSelection,
      selectedCount: summaries.length,
      completedCount: exports.length,
      complete: failedTickets.length === 0,
      exports,
      failedTickets,
      completedTickets,
      budget: this.exportUsageReport(mediaMode, mode === "write" ? ledger.snapshot() : usage),
    };
  }

  /** 复用单项导出的完整详情和受控媒体写入逻辑。 */
  private async exportLoadedTicket(
    profile: string | undefined,
    ticket: CanonicalTicket,
    mode: "plan" | "write",
    mediaMode: TicketMediaMode,
    usage?: MutableExportUsage,
    ledger?: ExportUsageLedger,
  ): Promise<TicketExportArtifact> {
    const media = mediaMode === "download" ? this.mediaPlan(ticket) : [];
    const mediaSummary = mediaMode === "download"
      ? assertMediaWithinLimits(media, this.exportLimits)
      : emptyMediaSummary();
    const candidate = ledger
      ? ledger.reserve(ticket, media, this.exportLimits)
      : {
        attachmentCount: (usage?.attachmentCount ?? 0) + ticket.attachments.length,
        plannedMedia: mergeMediaSummaries(usage?.plannedMedia ?? emptyMediaSummary(), mediaSummary),
        downloadedBytes: usage?.downloadedBytes ?? 0,
      };
    if (mediaMode === "download") assertMediaSummaryWithinLimits(candidate.plannedMedia, this.exportLimits);
    if (mode === "plan") {
      const plan = await this.dependencies.bundleStore.plan(ticket, media);
      if (usage) this.commitExportUsage(usage, candidate);
      return { ...plan, budget: this.ticketBudgetReport(mediaMode, candidate) };
    }
    const written = await this.downloadMissingMedia(profile, ticket, media, candidate.downloadedBytes, ledger);
    const completed = ledger ? ledger.snapshot() : { ...candidate, downloadedBytes: written.downloadedBytes };
    if (usage) this.commitExportUsage(usage, completed);
    return { ...written.result, budget: this.ticketBudgetReport(mediaMode, completed) };
  }

  /** 已验证媒体只暂存一次；仅将缺失文件下载到同一原子导出会话。 */
  private async downloadMissingMedia(
    profile: string | undefined,
    ticket: CanonicalTicket,
    media: TicketMediaPlan[],
    alreadyDownloadedBytes: number,
    ledger?: ExportUsageLedger,
  ): Promise<{ result: ExportResult; downloadedBytes: number }> {
    const session = await this.dependencies.bundleStore.beginExport(ticket, media);
    const selectedProfile = this.profile(profile);
    let downloadedBytes = alreadyDownloadedBytes;
    try {
      for (const item of session.missingMedia) {
        const download = await this.mediaProvider().downloadAttachment(selectedProfile, item.attachment, { maxBytes: this.exportLimits.maxAttachmentBytes });
        downloadedBytes = assertDownloadedBytes(download.bytes, item.attachment, downloadedBytes, this.exportLimits);
        ledger?.addDownloaded(download.bytes, item.attachment, this.exportLimits);
        await session.writeMedia(item, download);
      }
      return { result: await session.commit(), downloadedBytes };
    } catch (error) {
      await session.abort();
      throw error;
    }
  }

  private emptyExportUsage(): MutableExportUsage {
    return { attachmentCount: 0, plannedMedia: emptyMediaSummary(), downloadedBytes: 0 };
  }

  private commitExportUsage(target: MutableExportUsage, value: MutableExportUsage): void {
    target.attachmentCount = value.attachmentCount;
    target.plannedMedia = value.plannedMedia;
    target.downloadedBytes = value.downloadedBytes;
  }

  private ticketBudgetReport(mediaMode: TicketMediaMode, usage: MutableExportUsage): TicketExportBudgetReport {
    return {
      mediaMode,
      attachmentCount: usage.attachmentCount,
      plannedMedia: usage.plannedMedia,
      downloadedBytes: usage.downloadedBytes,
      limits: { ...this.exportLimits },
    };
  }

  private exportUsageReport(mediaMode: TicketMediaMode, usage: MutableExportUsage): TicketSearchExportBudgetReport {
    return this.ticketBudgetReport(mediaMode, usage);
  }

  /** 先在应用层规范化查询，再把 profile 和 page size 绑定到公共 cursor。 */
  private resolveSearch(input: TicketSearchInput) {
    const normalized = normalizeTicketSearchInput(input);
    const profile = this.profile(normalized.profile);
    if (normalized.query.scope === "project" && profile.allowedProjects.length === 0) {
      throw new TicketError("SOURCE_NOT_ALLOWED", "Project-scope search requires a non-empty profile project allowlist");
    }
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
      if (page.totalCount > this.exportLimits.maxItems) {
        throw new TicketError("EXPORT_LIMIT_EXCEEDED", `Ticket search matches more than the configured export limit of ${this.exportLimits.maxItems} items`);
      }
      for (const item of response.items) {
        if (ids.has(item.id)) throw new TicketError("SOURCE_SCHEMA_CHANGED", "Ticket search provider returned a duplicate item across pages");
        ids.add(item.id);
        summaries.push(item);
      }
      if (summaries.length > this.exportLimits.maxItems) {
        throw new TicketError("EXPORT_LIMIT_EXCEEDED", `Ticket search exceeds the configured export limit of ${this.exportLimits.maxItems} items`);
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

  /** 导出在搜索规范化后附加展示状态名，并将其绑定到冻结选择。 */
  private resolveExportSearch(input: TicketExportSearchInput) {
    const normalized = normalizeTicketExportSearchInput(input);
    const profile = this.profile(normalized.profile);
    if (normalized.query.scope === "project" && profile.allowedProjects.length === 0) {
      throw new TicketError("SOURCE_NOT_ALLOWED", "Project-scope search requires a non-empty profile project allowlist");
    }
    const fingerprint = ticketExportSearchFingerprint(profile.name, normalized.query, normalized.statuses);
    return { profile, query: normalized.query, statuses: normalized.statuses, fingerprint, cursor: normalized.cursor };
  }

  private isAuthorizationError(error: unknown): boolean {
    return error instanceof TicketError && (error.code === "SOURCE_UNAUTHORIZED" || error.code === "HUMAN_ACTION_REQUIRED");
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new TicketError("REQUEST_CANCELLED", "The ticket request was cancelled before another work item started");
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
