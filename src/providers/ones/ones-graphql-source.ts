import { getProfile, OnesConfig, OnesProfile } from "./ones-config.js";
import { HttpClient, FetchHttpClient, parseJsonResponse } from "../../infrastructure/http/fetch-http-client.js";
import { CanonicalTicket, TicketAttachment, TicketReference, TicketSearchProviderResult, TicketSearchQuery, TicketSummary } from "../../modules/tickets/domain/ticket.js";
import { TicketError as OnesError } from "../../modules/tickets/domain/ticket-error.js";
import { ConnectionStatus, TicketMediaDownload, TicketMediaDownloadOptions, TicketMediaProvider, TicketProfile, TicketProvider } from "../../modules/tickets/domain/ports.js";
import { SecretProvider, EnvSecretProvider } from "../../infrastructure/security/env-secret-provider.js";
import { normalizeOnesTicket } from "./ones-ticket-mapper.js";
import { OnesRawTicketData } from "./ones-contracts.js";
import { AsyncSemaphore } from "../../infrastructure/async-semaphore.js";

type UnknownRecord = Record<string, unknown>;

/** 与已归档的 ONES 列表样本保持同一 bucket、filterGroup 与 cursor 分页契约。 */
const SEARCH_QUERY = `{
  buckets(groupBy: $groupBy, orderBy: $groupOrderBy, pagination: $pagination) {
    key
    tasks(filterGroup: $filterGroup, orderBy: $orderBy, limit: 2000) {
      key name uuid number
      status { uuid name category }
      assign { uuid name }
      project { uuid }
    }
    pageInfo { count totalCount startCursor endCursor hasNextPage }
  }
}`;

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

/** 连接状态只需执行一个最小的受控搜索，不再依赖旧的树形待办查询。 */
export function myOpenTicketSearchQuery(size: number): TicketSearchQuery {
  return {
    scope: "self",
    state: "open",
    filter: {
      all: [
        { field: "statusCategory", op: "notIn", values: ["done"] },
        { field: "assignee", op: "in", values: ["me"] },
      ],
    },
    sort: { field: "createTime", direction: "desc" },
    page: { size },
  };
}

/** 将规范领域查询编译为已验证的 ONES 列表 variables；MCP 输入不直接参与此过程。 */
export function compileOnesTicketSearchVariables(profile: OnesProfile, query: TicketSearchQuery): UnknownRecord {
  if (query.sort.field !== "createTime" || query.sort.direction !== "desc") {
    throw new OnesError("QUERY_INVALID", "ONES ticket search only supports createTime descending order");
  }
  if (!Number.isInteger(query.page.size) || query.page.size < 1 || query.page.size > 50) {
    throw new OnesError("QUERY_INVALID", "ONES ticket search page size must be between 1 and 50");
  }
  const filterGroup: UnknownRecord = {};
  for (const filter of query.filter.all) {
    if (filter.field === "title" && filter.op === "contains") filterGroup.name_match = filter.value;
    else if (filter.field === "issueType" && filter.op === "in") filterGroup.issueType_in = filter.values;
    else if (filter.field === "statusCategory" && filter.op === "in") filterGroup.statusCategory_in = filter.values;
    else if (filter.field === "statusCategory" && filter.op === "notIn") filterGroup.statusCategory_notIn = filter.values;
    else if (filter.field === "assignee" && filter.op === "in" && filter.values.length === 1 && filter.values[0] === "me") filterGroup.assign_in = ["$currentUser"];
    else throw new OnesError("UNSUPPORTED_FILTER", "The requested ticket filter is not supported by the ONES v1 adapter");
  }
  // 项目范围来自受控 profile，而非公共 filter；它只能收窄而不能由调用方扩大。
  if (profile.allowedProjects.length > 0) filterGroup.project_in = [...profile.allowedProjects];
  return {
    groupBy: { tasks: {} },
    groupOrderBy: null,
    orderBy: { createTime: "DESC" },
    filterGroup: [filterGroup],
    search: null,
    pagination: {
      limit: query.page.size,
      ...(query.page.after ? { after: query.page.after } : { preciseCount: false }),
    },
  };
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

/** 有上限地读取媒体响应，避免未知 Content-Length 走 arrayBuffer 时无界累积。 */
async function readAttachmentBytes(response: Response, maxBytes?: number): Promise<Uint8Array> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (maxBytes !== undefined && Number.isSafeInteger(declaredSize) && declaredSize > maxBytes) {
    throw new OnesError("EXPORT_LIMIT_EXCEEDED", `attachment download exceeds the configured per-file limit of ${maxBytes} bytes`);
  }
  if (maxBytes === undefined || !response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
      throw new OnesError("EXPORT_LIMIT_EXCEEDED", `attachment download exceeds the configured per-file limit of ${maxBytes} bytes`);
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      const candidate = total + chunk.byteLength;
      if (!Number.isSafeInteger(candidate) || candidate > maxBytes) {
        await reader.cancel();
        throw new OnesError("EXPORT_LIMIT_EXCEEDED", `attachment download exceeds the configured per-file limit of ${maxBytes} bytes`);
      }
      total = candidate;
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class OnesGraphqlSource implements TicketProvider, TicketMediaProvider {
  readonly providerId = "ones";
  private readonly requestStates = new Map<string, { times: number[]; semaphore: AsyncSemaphore }>();

  /** 创建 ONES provider，并注入可替换的密钥和 HTTP 实现。 */
  constructor(
    protected readonly config: OnesConfig,
    private readonly secrets: SecretProvider = new EnvSecretProvider(),
    private readonly http: HttpClient = new FetchHttpClient(),
  ) {}

  /** 通过最小只读查询确认 profile 配置和授权状态。 */
  async status(ticketProfile: TicketProfile): Promise<ConnectionStatus> {
    try {
      await this.search(ticketProfile, myOpenTicketSearchQuery(1));
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

  /** 执行已验证的扁平列表查询，并把 ONES pageInfo 映射为 provider-neutral 分页结果。 */
  async search(ticketProfile: TicketProfile, query: TicketSearchQuery): Promise<TicketSearchProviderResult> {
    const profile = this.profileFor(ticketProfile);
    const response = await this.graphql(profile, SEARCH_QUERY, compileOnesTicketSearchVariables(profile, query), "searchGraphql");
    const buckets = asArray(asRecord(asRecord(response).data).buckets);
    if (buckets.length === 0) {
      return { items: [], page: { returned: 0, totalCount: 0, hasNextPage: false } };
    }
    const bucket = asRecord(buckets[0]);
    const rawTasks = asArray(bucket.tasks);
    const items = rawTasks.map((task) => this.normalizeSearchSummary(profile, task));
    const pageInfo = asRecord(bucket.pageInfo);
    const returned = pageInfo.count;
    const totalCount = pageInfo.totalCount;
    if (typeof returned !== "number" || !Number.isSafeInteger(returned) || returned < 0 || returned !== items.length) {
      throw new OnesError("SOURCE_SCHEMA_CHANGED", "searchGraphql returned an inconsistent pageInfo.count");
    }
    if (typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount < returned) {
      throw new OnesError("SOURCE_SCHEMA_CHANGED", "searchGraphql returned an invalid pageInfo.totalCount");
    }
    if (typeof pageInfo.hasNextPage !== "boolean") {
      throw new OnesError("SOURCE_SCHEMA_CHANGED", "searchGraphql returned an invalid pageInfo.hasNextPage continuation flag");
    }
    const hasNextPage = pageInfo.hasNextPage;
    const endCursor = stringValue(pageInfo.endCursor);
    if (hasNextPage && !endCursor) {
      throw new OnesError("SOURCE_SCHEMA_CHANGED", "searchGraphql reported another page without pageInfo.endCursor");
    }
    return {
      items,
      page: {
        returned,
        totalCount,
        hasNextPage,
        ...(endCursor ? { endCursor } : {}),
      },
    };
  }

  /** 获取原始 ONES 详情并在 provider 边界归一化为 CanonicalTicket。 */
  async getTicket(ticketProfile: TicketProfile, reference: TicketReference): Promise<CanonicalTicket> {
    const profile = this.profileFor(ticketProfile);
    return normalizeOnesTicket(profile, await this.getRawTicket(ticketProfile, reference));
  }

  /** 将 ONES 附件 UUID 解析为短时 URL，并立即读取其字节内容。 */
  async downloadAttachment(ticketProfile: TicketProfile, attachment: TicketAttachment, options?: TicketMediaDownloadOptions): Promise<TicketMediaDownload> {
    const profile = this.profileFor(ticketProfile);
    const url = await this.resolveAttachmentUrl(profile, attachment.id);
    return this.downloadResolvedAttachment(profile, attachment, url, options);
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

  protected async downloadResolvedAttachment(profile: OnesProfile, attachment: TicketAttachment, url: URL, options?: TicketMediaDownloadOptions): Promise<TicketMediaDownload> {
    return this.withRequestSlot(profile, () => this.retryRateLimited(profile, async () => {
      await this.acquireBudget(profile);
      const token = await this.resolveToken(profile);
      const authorization = profile.authentication.scheme === "Bearer" ? `Bearer ${token}` : token;
      const response = await fetch(url, { headers: { [profile.authentication.headerName]: authorization }, redirect: "manual" });
      if (response.status === 401 || response.status === 403) throw new OnesError("SOURCE_UNAUTHORIZED", `attachment download returned ${response.status}`);
      if (response.status === 429) throw new OnesRateLimitError("attachment download was rate limited", retryAfterMilliseconds(response.headers.get("retry-after"), this.now()));
      if (!response.ok) throw new OnesError("SOURCE_FAILED", `attachment download returned ${response.status}`);
      const contentType = response.headers.get("content-type") ?? undefined;
      const bytes = await readAttachmentBytes(response, options?.maxBytes);
      return { attachment, bytes, ...(contentType ? { contentType } : {}) };
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

  /** 将 ONES 列表行映射为平铺摘要，并在 provider 边界再次强制项目 allowlist。 */
  protected normalizeSearchSummary(profile: OnesProfile, raw: unknown): TicketSummary {
    const task = asRecord(raw);
    const id = stringValue(task.uuid);
    if (!id) throw new OnesError("SOURCE_SCHEMA_CHANGED", "Search item is missing uuid");
    const project = asRecord(task.project);
    const projectId = stringValue(project.uuid);
    if (profile.allowedProjects.length > 0 && (!projectId || !profile.allowedProjects.includes(projectId))) {
      throw new OnesError("SOURCE_NOT_ALLOWED", "Search item project is outside the profile allowlist");
    }
    const status = asRecord(task.status);
    const category = stringValue(status.category);
    if (category && category !== "to_do" && category !== "in_progress" && category !== "done") {
      throw new OnesError("SOURCE_SCHEMA_CHANGED", "Search item contains an unsupported status category");
    }
    const assignee = asRecord(task.assign);
    const assigneeId = stringValue(assignee.uuid);
    const assigneeName = stringValue(assignee.name);
    const number = typeof task.number === "number" || typeof task.number === "string" ? String(task.number) : undefined;
    return {
      id,
      ...(stringValue(task.key) ? { key: stringValue(task.key) } : {}),
      ...(number ? { number } : {}),
      title: stringValue(task.name) ?? id,
      ...(stringValue(status.uuid) || stringValue(status.name) || category
        ? {
          status: {
            ...(stringValue(status.uuid) ? { id: stringValue(status.uuid) } : {}),
            ...(stringValue(status.name) ? { name: stringValue(status.name) } : {}),
            ...(category ? { category: category as "to_do" | "in_progress" | "done" } : {}),
          },
        }
        : {}),
      ...(assigneeId || assigneeName ? { assignee: { ...(assigneeId ? { id: assigneeId } : {}), ...(assigneeName ? { displayName: assigneeName } : {}) } } : {}),
      ...(projectId ? { projectId } : {}),
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

  /** 每个 profile 拥有独立的有界请求队列，互不消耗 ONES 请求预算。 */
  protected async withRequestSlot<T>(profile: OnesProfile, operation: () => Promise<T>): Promise<T> {
    const state = this.requestState(profile);
    const release = await state.semaphore.acquire();
    try {
      return await operation();
    } finally {
      release();
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
      state = { times: [], semaphore: new AsyncSemaphore(profile.requestBudget.maxConcurrent) };
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
