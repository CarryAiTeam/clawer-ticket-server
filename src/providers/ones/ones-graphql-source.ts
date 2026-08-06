import { getProfile, OnesConfig, OnesProfile } from "./ones-config.js";
import { HttpClient, FetchHttpClient, parseJsonResponse } from "../../infrastructure/http/fetch-http-client.js";
import { CanonicalTicket, TicketAttachment, TicketIndexItem, TicketIndexTree, TicketReference } from "../../modules/tickets/domain/ticket.js";
import { TicketError as OnesError } from "../../modules/tickets/domain/ticket-error.js";
import { ConnectionStatus, TicketMediaDownload, TicketMediaProvider, TicketProfile, TicketProvider } from "../../modules/tickets/domain/ports.js";
import { SecretProvider, EnvSecretProvider } from "../../infrastructure/security/env-secret-provider.js";
import { normalizeOnesTicket } from "./ones-ticket-mapper.js";
import { OnesRawTicketData } from "./ones-contracts.js";

type UnknownRecord = Record<string, unknown>;

const MY_OPEN_TREE_QUERY = `{
  buckets(groupBy: $groupBy, orderBy: $groupOrderBy, pagination: $pagination, filter: $groupFilter) {
    key
    tasks(filterGroup: $filterGroup, orderBy: $orderBy, limit: $taskLimit, includeAncestors: { pathField: "path" }, orderByPath: "path") {
      key name uuid serverUpdateStamp number path subTaskCount subTaskDoneCount position
      status { uuid name category }
      assign { uuid name }
      deadline(unit: ONESDATE)
      subTasks { uuid }
      issueType { uuid manhourStatisticMode }
      subIssueType { uuid manhourStatisticMode }
      project { uuid }
      parent { uuid }
      importantField { bgColor color name value fieldUUID }
    }
    pageInfo { count totalCount startPos endPos hasNextPage preciseCount }
  }
}`;

/** 使用相同固定筛选条件，但不包含仅用于树结构的父级行。 */
const MY_OPEN_MATCHED_QUERY = MY_OPEN_TREE_QUERY.replace(', includeAncestors: { pathField: "path" }', "");

/** ONES 工单详情视图使用的字段；应与附件查询保持独立。 */
const DETAIL_QUERY = `query TaskDetail($key: Key) {
  task(key: $key) {
    uuid key name number path createTime serverUpdateStamp
    description
    desc_rich: description
    descriptionText
    status { uuid name category }
    priority { uuid value }
    assign { uuid name email }
    owner { uuid name email }
    issueType { uuid name }
    subIssueType { uuid name }
    project { uuid name }
    sprint { uuid name project { uuid } }
    parent { uuid }
    subTasks { uuid key name status { name } }
    links { taskUUID linkDescType taskLinkTypeUUID }
    relatedTasks { uuid key name status { name category } project { uuid name } }
    importantField { fieldUUID name value }
  }
}`;

/** 此处严格匹配 ONES 3.14 前端请求的附件字段形态。 */
const ATTACHMENTS_QUERY = `query TaskAttachments($key: Key) {
  task(key: $key) {
    attachments {
      uuid size referenceType ref_type: referenceType referenceId ref_id: referenceId
      owner { uuid name avatar }
      name mime hash createTime create_time: createTime
    }
  }
}`;

/** 将未知响应值收窄为普通对象，避免直接信任第三方 JSON。 */
function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

/** 将未知响应值安全转换为数组。 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 读取非空字符串字段，统一处理 ONES 的缺失值。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

class OnesRateLimitError extends OnesError {
  constructor(message: string, readonly retryAfterMs?: number) {
    super("SOURCE_RATE_LIMITED", message);
  }
}

function retryAfterMilliseconds(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1_000), 60_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - now, 0), 60_000) : undefined;
}

export class OnesGraphqlSource implements TicketProvider, TicketMediaProvider {
  readonly providerId = "ones";
  private readonly requestStates = new Map<string, { times: number[]; tail: Promise<void> }>();

  /** 创建 ONES provider，并注入可替换的密钥和 HTTP 实现。 */
  constructor(
    protected readonly config: OnesConfig,
    private readonly secrets: SecretProvider = new EnvSecretProvider(),
    private readonly http: HttpClient = new FetchHttpClient(),
  ) {}

  /** 通过最小只读查询确认 profile 配置和授权状态。 */
  async status(ticketProfile: TicketProfile): Promise<ConnectionStatus> {
    const profile = this.profileFor(ticketProfile);
    try {
      await this.resolveToken(profile);
      await this.graphql(profile, MY_OPEN_MATCHED_QUERY, this.myOpenVariables(profile, 1), "authorizationProbe");
      return {
        configured: true,
        credentialAvailable: true,
        authorized: true,
        diagnostics: ["credential was accepted by the ONES my-open GraphQL contract"],
      };
    } catch (error) {
      if (error instanceof OnesError && error.code === "SECRET_UNAVAILABLE") {
        return { configured: true, credentialAvailable: false, authorized: false, diagnostics: [error.code] };
      }
      if (error instanceof OnesError) {
        return { configured: true, credentialAvailable: true, authorized: false, diagnostics: [`online authorization probe failed: ${error.code}`] };
      }
      throw error;
    }
  }

  /** 获取当前用户未完成工单树，并区分匹配项与父级上下文项。 */
  async listMyOpen(ticketProfile: TicketProfile, limit: number): Promise<TicketIndexTree> {
    const profile = this.profileFor(ticketProfile);
    const safeLimit = Math.min(Math.max(limit, 1), 1_000);
    const variables = this.myOpenVariables(profile, safeLimit);
    const response = await this.graphql(profile, MY_OPEN_TREE_QUERY, variables);
    const matchedResponse = await this.graphql(profile, MY_OPEN_MATCHED_QUERY, variables);
    const data = asRecord(response).data;
    const bucket = asArray(asRecord(data).buckets)[0];
    const bucketRecord = asRecord(bucket);
    const items = asArray(bucketRecord.tasks)
      .map((task) => this.normalizeIndexItem(profile, task))
      .filter((item) => profile.allowedProjects.length === 0 || (item.projectId !== undefined && profile.allowedProjects.includes(item.projectId)));
    const matchedBucket = asRecord(asArray(asRecord(asRecord(matchedResponse).data).buckets)[0]);
    const matchedIds = new Set(
      asArray(matchedBucket.tasks)
        .map((task) => this.normalizeIndexItem(profile, task))
        .filter((item) => profile.allowedProjects.length === 0 || (item.projectId !== undefined && profile.allowedProjects.includes(item.projectId)))
        .map((item) => item.id),
    );
    const roots: string[] = [];
    const externalParentIds: string[] = [];
    for (const item of items) {
      item.matchedFilter = matchedIds.has(item.id);
      item.includedAsAncestor = !item.matchedFilter;
      if (!item.parentId) roots.push(item.id);
      else if (!items.some((candidate) => candidate.id === item.parentId)) externalParentIds.push(item.parentId);
    }
    const pageInfo = asRecord(bucketRecord.pageInfo);
    const matchedPageInfo = asRecord(matchedBucket.pageInfo);
    const preciseMatchedCount = typeof matchedPageInfo.preciseCount === "number"
      ? matchedPageInfo.preciseCount
      : typeof matchedPageInfo.totalCount === "number"
        ? matchedPageInfo.totalCount
        : matchedIds.size;
    return {
      view: "my_open_tree",
      items,
      roots,
      externalParentIds: [...new Set(externalParentIds)],
      page: {
        count: items.length,
        matchedCount: preciseMatchedCount,
        contextCount: items.length - matchedIds.size,
        totalCount: typeof pageInfo.totalCount === "number" ? pageInfo.totalCount : undefined,
        hasNextPage: matchedPageInfo.hasNextPage === true,
      },
    };
  }

  /** 获取原始 ONES 详情并在 provider 边界归一化为 CanonicalTicket。 */
  async getTicket(ticketProfile: TicketProfile, reference: TicketReference): Promise<CanonicalTicket> {
    const profile = this.profileFor(ticketProfile);
    return normalizeOnesTicket(profile, await this.getRawTicket(ticketProfile, reference));
  }

  /** 将 ONES 附件 UUID 解析为短时 URL，并立即读取其字节内容。 */
  async downloadAttachment(ticketProfile: TicketProfile, attachment: TicketAttachment): Promise<TicketMediaDownload> {
    const profile = this.profileFor(ticketProfile);
    const url = await this.resolveAttachmentUrl(profile, attachment.id);
    return this.downloadResolvedAttachment(profile, attachment, url);
  }

  /** 临时 URL 仅保留在内存中，绝不写入 CanonicalTicket。 */
  protected async resolveAttachmentUrl(profile: OnesProfile, attachmentId: string): Promise<URL> {
    const result = asRecord(await this.requestJson(profile, "GET", `res/attachment/${encodeURIComponent(attachmentId)}?op=download&action=download`));
    const value = stringValue(result.url);
    if (!value) throw new OnesError("SOURCE_SCHEMA_CHANGED", "attachment resolver did not return url");
    let url: URL;
    try { url = new URL(value, profile.baseUrl); } catch { throw new OnesError("SOURCE_SCHEMA_CHANGED", "attachment resolver returned an invalid url"); }
    if (!profile.allowedHosts.includes(url.host)) throw new OnesError("SOURCE_FAILED", "attachment resolver returned a host outside the profile allowlist");
    return url;
  }

  protected async downloadResolvedAttachment(profile: OnesProfile, attachment: TicketAttachment, url: URL): Promise<TicketMediaDownload> {
    return this.withRequestSlot(profile, () => this.retryRateLimited(profile, async () => {
      await this.acquireBudget(profile);
      const token = await this.resolveToken(profile);
      const authorization = profile.authentication.scheme === "Bearer" ? `Bearer ${token}` : token;
      const response = await fetch(url, { headers: { [profile.authentication.headerName]: authorization }, redirect: "manual" });
      if (response.status === 401 || response.status === 403) throw new OnesError("SOURCE_UNAUTHORIZED", `attachment download returned ${response.status}`);
      if (response.status === 429) throw new OnesRateLimitError("attachment download was rate limited", retryAfterMilliseconds(response.headers.get("retry-after"), this.now()));
      if (!response.ok) throw new OnesError("SOURCE_FAILED", `attachment download returned ${response.status}`);
      const contentType = response.headers.get("content-type") ?? undefined;
      return { attachment, bytes: new Uint8Array(await response.arrayBuffer()), ...(contentType ? { contentType } : {}) };
    }));
  }

  /** 获取浏览器 reconciliation 所需的原始 ONES 数据；该类型不会离开 provider。 */
  protected async getRawTicket(ticketProfile: TicketProfile, reference: TicketReference): Promise<OnesRawTicketData> {
    const profile = this.profileFor(ticketProfile);
    const key = this.toTaskKey(reference.id);
    const detailResponse = await this.graphql(profile, DETAIL_QUERY, { key }, "detailGraphql");
    const task = asRecord(asRecord(detailResponse).data).task;
    if (!task) throw new OnesError("SOURCE_SCHEMA_CHANGED", "detailGraphql did not return data.task");
    const detail = asRecord(task);
    this.assertAllowedProject(profile, detail);
    const attachmentResponse = await this.graphql(profile, ATTACHMENTS_QUERY, { key }, "attachmentsGraphql");
    const attachmentTask = asRecord(asRecord(attachmentResponse).data).task;
    if (!attachmentTask) throw new OnesError("SOURCE_SCHEMA_CHANGED", "attachmentsGraphql did not return data.task");
    const messages = await this.rest(profile, `task/${encodeURIComponent(reference.id)}/messages`, "messages");
    return { detail, messages, attachments: { attachments: asArray(asRecord(attachmentTask).attachments) } };
  }

  /** 校验 profile 与 ONES provider 一致，并解析对应的 ONES 专属配置。 */
  protected profileFor(ticketProfile: TicketProfile): OnesProfile {
    if (ticketProfile.providerId !== this.providerId) {
      throw new OnesError("CONFIG_INVALID", `ONES adapter cannot use profile ${ticketProfile.name} for provider ${ticketProfile.providerId}`);
    }
    return getProfile(this.config, ticketProfile.name);
  }

  /** 在详情响应上执行项目 allowlist 校验。 */
  private assertAllowedProject(profile: OnesProfile, detail: UnknownRecord): void {
    const projectId = stringValue(asRecord(detail.project).uuid);
    if (profile.allowedProjects.length > 0 && (!projectId || !profile.allowedProjects.includes(projectId))) {
      throw new OnesError("SOURCE_NOT_ALLOWED", "Ticket project is outside the profile allowlist");
    }
  }

  /** 生成与 ONES“我负责且未完成”视图一致的查询变量。 */
  private myOpenVariables(profile: OnesProfile, limit: number): UnknownRecord {
    return {
      groupBy: { tasks: {} },
      groupOrderBy: null,
      // 与已认证的 ONES 筛选视图保持一致：工单分页位于单个 bucket 中，
      // UI 会显式请求完整树结构。
      orderBy: { position: "ASC", createTime: "DESC" },
      filterGroup: [{
        statusCategory_notIn: ["done"],
        assign_in: ["$currentUser"],
        ...(profile.allowedProjects.length > 0 ? { project_in: profile.allowedProjects } : {}),
      }],
      groupFilter: null,
      pagination: { limit: Math.min(limit, 50), preciseCount: false },
      taskLimit: 2_000,
    };
  }

  /** 将 ONES 列表行映射为通用树索引项。 */
  protected normalizeIndexItem(profile: OnesProfile, raw: unknown): TicketIndexItem {
    const task = asRecord(raw);
    const status = asRecord(task.status);
    const assign = asRecord(task.assign);
    const parent = asRecord(task.parent);
    const subTasks = asArray(task.subTasks).map((entry) => stringValue(asRecord(entry).uuid)).filter((id): id is string => Boolean(id));
    const project = asRecord(task.project);
    const id = stringValue(task.uuid);
    if (!id) throw new OnesError("SOURCE_SCHEMA_CHANGED", "List item is missing uuid");
    const importantFields = asArray(task.importantField);
    const assigneeField = profile.listAssigneeFieldId
      ? importantFields.find((field) => asRecord(field).fieldUUID === profile.listAssigneeFieldId)
      : undefined;
    return {
      id,
      key: stringValue(task.key),
      title: stringValue(task.name) ?? id,
      status: stringValue(status.name),
      assignee: stringValue(assign.uuid) || stringValue(assign.name)
        ? { id: stringValue(assign.uuid), displayName: stringValue(assign.name) }
        : assigneeField ? { displayName: stringValue(asRecord(assigneeField).value) } : undefined,
      projectId: stringValue(project.uuid),
      parentId: stringValue(parent.uuid),
      path: stringValue(task.path),
      childIds: subTasks,
      matchedFilter: "unknown",
      includedAsAncestor: false,
    };
  }

  /** 将外部工单 ID 转换为 ONES GraphQL 使用的 task key。 */
  private toTaskKey(id: string): string {
    return id.startsWith("task-") ? id : `task-${id}`;
  }

  /** 执行 ONES GraphQL 请求并把协议或 schema 错误附加到阶段信息。 */
  private async graphql(profile: OnesProfile, query: string, variables: UnknownRecord, stage = "graphql"): Promise<unknown> {
    try {
      const result = await this.requestJson(profile, "POST", "items/graphql", JSON.stringify({ query, variables }));
      const errors = asArray(asRecord(result).errors)
        .map((error) => stringValue(asRecord(error).message))
        .filter((message): message is string => Boolean(message));
      if (errors.length > 0) throw new OnesError("SOURCE_SCHEMA_CHANGED", `${stage}: ONES GraphQL rejected the query (${errors.join("; ")})`);
      return result;
    } catch (error) {
      if (error instanceof OnesError) throw new OnesError(error.code, `${stage}: ${error.message}`);
      throw error;
    }
  }

  /** 执行 ONES 消息等 REST 请求，并统一错误阶段名称。 */
  private async rest(profile: OnesProfile, path: string, stage: string): Promise<unknown> {
    try {
      return await this.requestJson(profile, "GET", path);
    } catch (error) {
      if (error instanceof OnesError) throw new OnesError(error.code, `${stage}: ${error.message}`);
      throw error;
    }
  }

  /** 通过受控 host、认证和请求预算发送 ONES JSON 请求。 */
  protected async requestJson(profile: OnesProfile, method: "GET" | "POST", relativePath: string, body?: string): Promise<unknown> {
    return this.withRequestSlot(profile, () => this.retryRateLimited(profile, async () => {
      await this.acquireBudget(profile);
      const token = await this.resolveToken(profile);
      const endpoint = new URL(`/project/api/project/team/${encodeURIComponent(profile.teamId)}/${relativePath}`, profile.baseUrl);
      if (!profile.allowedHosts.includes(endpoint.host)) throw new OnesError("SOURCE_FAILED", "Resolved endpoint is outside the profile host allowlist");
      const authorization = profile.authentication.scheme === "Bearer" ? `Bearer ${token}` : token;
      const response = await this.http.request({
        url: endpoint,
        method,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          [profile.authentication.headerName]: authorization,
        },
        ...(body ? { body } : {}),
      });
      if (response.status === 429) throw new OnesRateLimitError("ONES request was rate limited", retryAfterMilliseconds(response.headers.get("retry-after"), this.now()));
      return parseJsonResponse(response);
    }));
  }

  /** 解析 profile 引用的密钥，禁止从调用方输入凭据。 */
  protected async resolveToken(profile: OnesProfile): Promise<string> {
    return this.secrets.resolve(profile.secretRef!);
  }

  /** 每个 profile 拥有独立串行请求队列，互不消耗 ONES 请求预算。 */
  protected async withRequestSlot<T>(profile: OnesProfile, operation: () => Promise<T>): Promise<T> {
    const state = this.requestState(profile);
    let release: (() => void) | undefined;
    const previous = state.tail;
    state.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  /** 等待滑动窗口中的下一个可用位置，避免将本地安全预算耗尽变成终止性导出失败。 */
  protected async acquireBudget(profile: OnesProfile): Promise<void> {
    const state = this.requestState(profile);
    for (;;) {
      const now = this.now();
      while (state.times.length > 0 && state.times[0]! <= now - 60_000) state.times.shift();
      if (state.times.length < profile.requestBudget.maxRequestsPerMinute) {
        state.times.push(now);
        return;
      }
      const next = state.times[0]! + 60_000 - now + 1;
      await this.delay(next);
    }
  }

  protected now(): number {
    return Date.now();
  }

  protected async delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  private requestState(profile: OnesProfile) {
    const key = `${profile.source}:${profile.baseUrl}:${profile.teamId}`;
    let state = this.requestStates.get(key);
    if (!state) {
      state = { times: [], tail: Promise.resolve() };
      this.requestStates.set(key, state);
    }
    return state;
  }

  protected rateLimited(message: string, retryAfter: string | null): Error {
    return new OnesRateLimitError(message, retryAfterMilliseconds(retryAfter, this.now()));
  }

  protected async retryRateLimited<T>(_profile: OnesProfile, operation: () => Promise<T>): Promise<T> {
    const maxRetries = 3;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof OnesRateLimitError) || attempt >= maxRetries) throw error;
        const exponential = Math.min(1_000 * 2 ** attempt, 15_000);
        const jitter = Math.floor(Math.random() * 250);
        await this.delay(error.retryAfterMs ?? exponential + jitter);
      }
    }
  }
}
