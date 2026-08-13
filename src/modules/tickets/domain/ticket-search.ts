import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  TicketFilter,
  TicketExportSearchInput,
  TicketSearchInput,
  TicketSearchQuery,
  TicketSearchSelection,
  TicketSearchScope,
  TicketSearchState,
  TicketStatusCategory,
} from "./ticket.js";
import { TicketError } from "./ticket-error.js";

const STATUS_CATEGORIES: readonly TicketStatusCategory[] = ["to_do", "in_progress", "done"];
const SEARCH_SCOPES: readonly TicketSearchScope[] = ["self", "project"];
const SEARCH_STATES: readonly TicketSearchState[] = ["open", "active", "done", "all"];
const MAX_FILTERS = 16;
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;
const MAX_CURSOR_LENGTH = 512;

type UnknownRecord = Record<string, unknown>;

export interface NormalizedTicketSearchInput {
  profile?: string;
  cursor?: string;
  query: TicketSearchQuery;
}

export interface NormalizedTicketExportSearchInput extends NormalizedTicketSearchInput {
  statuses: string[];
}

export interface TicketSearchCursorBinding {
  profile: string;
  fingerprint: string;
  pageSize: number;
}

interface TicketSearchCursorEntry extends TicketSearchCursorBinding {
  after: string;
  expiresAt: number;
}

/** 返回稳定的调用方错误，不将 provider 或内部 cursor 信息暴露到 MCP。 */
function invalid(message: string): never {
  throw new TicketError("QUERY_INVALID", message);
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) invalid(`${label} must be an object`);
  return value;
}

function onlyKeys(value: UnknownRecord, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) invalid(`${label} contains unsupported field ${unexpected[0]}`);
}

function nonEmptyString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") invalid(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) invalid(`${label} must not be empty`);
  if (normalized.length > maxLength) invalid(`${label} exceeds ${maxLength} characters`);
  return normalized;
}

function stringArray(value: unknown, label: string, maxItems: number, itemMaxLength: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) invalid(`${label} must contain 1..${maxItems} values`);
  const normalized = value.map((item, index) => nonEmptyString(item, `${label}[${index}]`, itemMaxLength));
  return [...new Set(normalized)].sort();
}

function statusArray(value: unknown, label: string): TicketStatusCategory[] {
  const values = stringArray(value, label, STATUS_CATEGORIES.length, 32);
  if (values.some((item) => !STATUS_CATEGORIES.includes(item as TicketStatusCategory))) {
    invalid(`${label} contains an unsupported status category`);
  }
  return values as TicketStatusCategory[];
}

function intersection(left: Set<string>, right: readonly string[]): Set<string> {
  return new Set([...left].filter((value) => right.includes(value)));
}

function orderedStatusCategories(values: ReadonlySet<string>): TicketStatusCategory[] {
  return STATUS_CATEGORIES.filter((category) => values.has(category));
}

/**
 * 解析 MCP 公开输入并将范围、状态与一层 AND 条件规范化。此函数不依赖 provider，
 * 因而 provider-specific GraphQL、view 或 raw after 参数不会越过领域边界。
 */
export function normalizeTicketSearchInput(value: TicketSearchInput | unknown): NormalizedTicketSearchInput {
  const input = record(value, "ticket_search input");
  onlyKeys(input, ["profile", "scope", "state", "where", "page"], "ticket_search input");

  const profile = input.profile === undefined ? undefined : nonEmptyString(input.profile, "profile", 128);
  const scope = input.scope === undefined ? "self" : input.scope;
  if (!SEARCH_SCOPES.includes(scope as TicketSearchScope)) invalid("scope must be self or project");
  const state = input.state === undefined ? "open" : input.state;
  if (!SEARCH_STATES.includes(state as TicketSearchState)) invalid("state must be open, active, done, or all");

  let cursor: string | undefined;
  let pageSize = DEFAULT_PAGE_SIZE;
  if (input.page !== undefined) {
    const page = record(input.page, "page");
    onlyKeys(page, ["size", "cursor"], "page");
    if (page.size !== undefined) {
      if (typeof page.size !== "number" || !Number.isInteger(page.size) || page.size < 1 || page.size > MAX_PAGE_SIZE) {
        invalid(`page.size must be an integer between 1 and ${MAX_PAGE_SIZE}`);
      }
      pageSize = page.size;
    }
    if (page.cursor !== undefined) cursor = nonEmptyString(page.cursor, "page.cursor", MAX_CURSOR_LENGTH);
  }

  const titles = new Set<string>();
  let issueTypes: Set<string> | undefined;
  let statusIn: Set<string> | undefined;
  let hasStatusIn = false;
  const statusNotIn = new Set<string>();
  let hasAssignee = scope === "self";
  let hasExplicitAssignee = false;

  const applyFilter = (filter: TicketFilter) => {
    switch (filter.field) {
      case "title":
        titles.add(filter.value);
        return;
      case "issueType": {
        const values = filter.values;
        issueTypes = issueTypes ? intersection(issueTypes, values) : new Set(values);
        return;
      }
      case "statusCategory":
        if (filter.op === "in") {
          hasStatusIn = true;
          statusIn = statusIn ? intersection(statusIn, filter.values) : new Set(filter.values);
        } else {
          for (const category of filter.values) statusNotIn.add(category);
        }
        return;
      case "assignee":
        hasExplicitAssignee = true;
        hasAssignee = true;
        return;
    }
  };

  if (state === "open") {
    statusNotIn.add("done");
  } else if (state === "active") {
    hasStatusIn = true;
    statusIn = new Set(["to_do", "in_progress"]);
  } else if (state === "done") {
    hasStatusIn = true;
    statusIn = new Set(["done"]);
  }

  if (input.where !== undefined) {
    const where = record(input.where, "where");
    onlyKeys(where, ["all"], "where");
    if (!Array.isArray(where.all) || where.all.length === 0 || where.all.length > MAX_FILTERS) {
      invalid(`where.all must contain 1..${MAX_FILTERS} filters`);
    }
    for (const [index, candidate] of where.all.entries()) {
      const filter = record(candidate, `where.all[${index}]`);
      const field = filter.field;
      if (field === "title") {
        onlyKeys(filter, ["field", "op", "value"], `where.all[${index}]`);
        if (filter.op !== "contains") invalid("title only supports contains");
        applyFilter({ field, op: "contains", value: nonEmptyString(filter.value, "title.value", 256) });
      } else if (field === "issueType") {
        onlyKeys(filter, ["field", "op", "values"], `where.all[${index}]`);
        if (filter.op !== "in") invalid("issueType only supports in");
        applyFilter({ field, op: "in", values: stringArray(filter.values, "issueType.values", 50, 128) });
      } else if (field === "statusCategory") {
        onlyKeys(filter, ["field", "op", "values"], `where.all[${index}]`);
        if (filter.op !== "in" && filter.op !== "notIn") invalid("statusCategory only supports in or notIn");
        applyFilter({ field, op: filter.op, values: statusArray(filter.values, "statusCategory.values") });
      } else if (field === "assignee") {
        onlyKeys(filter, ["field", "op", "values"], `where.all[${index}]`);
        if (filter.op !== "in" || !Array.isArray(filter.values) || filter.values.length !== 1 || filter.values[0] !== "me") {
          invalid("assignee only supports in [\"me\"]");
        }
        applyFilter({ field, op: "in", values: ["me"] });
      } else {
        invalid("filter field is unsupported");
      }
    }
  }

  if (titles.size > 1) invalid("title may appear only once in a v1 search");
  if (issueTypes && issueTypes.size === 0) invalid("issueType filters do not overlap");
  if (scope === "project" && hasExplicitAssignee) invalid("assignee may be used only with scope self");

  if (statusIn) {
    for (const category of statusNotIn) statusIn.delete(category);
    if (statusIn.size === 0) invalid("statusCategory filters do not overlap");
  } else if (hasStatusIn) {
    invalid("statusCategory filters do not overlap");
  } else if (statusNotIn.size === STATUS_CATEGORIES.length) {
    invalid("statusCategory filters exclude every v1 category");
  }

  const filters: TicketFilter[] = [];
  const title = [...titles][0];
  if (title) filters.push({ field: "title", op: "contains", value: title });
  if (issueTypes) filters.push({ field: "issueType", op: "in", values: [...issueTypes].sort() });
  if (statusIn) {
    filters.push({ field: "statusCategory", op: "in", values: orderedStatusCategories(statusIn) });
  } else if (statusNotIn.size > 0) {
    filters.push({ field: "statusCategory", op: "notIn", values: orderedStatusCategories(statusNotIn) });
  }
  if (hasAssignee) filters.push({ field: "assignee", op: "in", values: ["me"] });

  return {
    ...(profile ? { profile } : {}),
    ...(cursor ? { cursor } : {}),
    query: {
      scope: scope as TicketSearchScope,
      state: state as TicketSearchState,
      filter: { all: filters },
      sort: { field: "createTime", direction: "desc" },
      page: { size: pageSize },
    },
  };
}

/**
 * 查询型导出可在受控基础查询上按 ONES 返回的展示状态名进一步筛选。
 * 该条件刻意不进入列表搜索，避免破坏其 provider 分页与计数契约。
 */
export function normalizeTicketExportSearchInput(value: TicketExportSearchInput | unknown): NormalizedTicketExportSearchInput {
  const input = record(value, "ticket_export query");
  onlyKeys(input, ["profile", "scope", "state", "where", "page", "statuses"], "ticket_export query");
  const statuses = input.statuses === undefined ? [] : stringArray(input.statuses, "statuses", 20, 128);
  const { statuses: _statuses, ...searchInput } = input;
  return { ...normalizeTicketSearchInput(searchInput), statuses };
}

/** 同一 profile、范围、状态、条件和固定排序始终产生同一 fingerprint。 */
export function ticketSearchFingerprint(profile: string, query: Pick<TicketSearchQuery, "scope" | "state" | "filter" | "sort">): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, profile, scope: query.scope, state: query.state, filter: query.filter, sort: query.sort }))
    .digest("hex");
}

/** 导出选择还绑定展示状态名，避免 plan 被另一状态条件的 write 复用。 */
export function ticketExportSearchFingerprint(profile: string, query: Pick<TicketSearchQuery, "scope" | "state" | "filter" | "sort">, statuses: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, queryFingerprint: ticketSearchFingerprint(profile, query), statuses }))
    .digest("hex");
}

/** 查询型导出冻结的是排序后 ID 集合，而非可变的显示字段。 */
export function ticketSelectionFingerprint(queryFingerprint: string, ids: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, queryFingerprint, ids })).digest("hex");
}

/** 验证调用方回传的 plan 阶段选择冻结。 */
export function validateSelection(value: TicketSearchSelection | unknown): TicketSearchSelection {
  const selection = record(value, "selection");
  onlyKeys(selection, ["expectedCount", "fingerprint"], "selection");
  if (typeof selection.expectedCount !== "number" || !Number.isSafeInteger(selection.expectedCount) || selection.expectedCount < 0) {
    invalid("selection.expectedCount must be a non-negative integer");
  }
  const fingerprint = nonEmptyString(selection.fingerprint, "selection.fingerprint", 128);
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) invalid("selection.fingerprint is invalid");
  return { expectedCount: selection.expectedCount, fingerprint };
}

/**
 * 内存 cursor 映射会签发不可猜测且经 HMAC 签名的 token。它不编码 ONES after，
 * 进程重启、过期、篡改、跨 profile 或跨查询复用都会稳定拒绝。
 */
export class TicketSearchCursorStore {
  private readonly entries = new Map<string, TicketSearchCursorEntry>();
  private readonly key = randomBytes(32);

  constructor(
    private readonly ttlMs = 30 * 60 * 1_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  issue(after: string, binding: TicketSearchCursorBinding): string {
    if (!after) throw new TicketError("SOURCE_SCHEMA_CHANGED", "Provider reported another page without an end cursor");
    this.prune();
    const id = randomBytes(24).toString("base64url");
    this.entries.set(id, { ...binding, after, expiresAt: this.now() + this.ttlMs });
    return `v1.${id}.${this.sign(id)}`;
  }

  resolve(token: string, binding: TicketSearchCursorBinding): string {
    this.prune();
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2] || token.length > MAX_CURSOR_LENGTH || !this.matchesSignature(parts[1]!, parts[2]!)) {
      throw new TicketError("QUERY_CURSOR_INVALID", "page.cursor is invalid, expired, or does not belong to this query");
    }
    const entry = this.entries.get(parts[1]!);
    if (!entry || entry.expiresAt <= this.now() || entry.profile !== binding.profile || entry.fingerprint !== binding.fingerprint || entry.pageSize !== binding.pageSize) {
      this.entries.delete(parts[1]!);
      throw new TicketError("QUERY_CURSOR_INVALID", "page.cursor is invalid, expired, or does not belong to this query");
    }
    return entry.after;
  }

  private sign(id: string): string {
    return createHmac("sha256", this.key).update(`ticket-search:v1:${id}`).digest("base64url");
  }

  private matchesSignature(id: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(id));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
  }
}
