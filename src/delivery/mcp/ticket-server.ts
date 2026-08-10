import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { TicketApplication } from "../../modules/tickets/application/ticket-application.js";
import { TicketError } from "../../modules/tickets/domain/ticket-error.js";

export interface TicketMcpServerDependencies {
  getApplication(): Promise<TicketApplication>;
}

/** 将任意业务结果投影为 MCP 文本响应，并按需标记为错误。 */
function textResult(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

/** 将领域错误转换为稳定的 MCP 错误载荷，避免泄露未处理异常结构。 */
function errorResult(error: unknown) {
  if (error instanceof TicketError) return textResult({ ok: false, error: { code: error.code, message: error.message } }, true);
  return textResult({ ok: false, error: { code: "UNEXPECTED", message: error instanceof Error ? error.message : "Unexpected error" } }, true);
}

/** 注册全部工单工具；此层只处理 schema 与结果映射，依赖由 bootstrap 注入。 */
export function createTicketMcpServer({ getApplication }: TicketMcpServerDependencies): McpServer {
  const server = new McpServer({ name: "clawer-ticket-mcp", version: "1.0.0" });
  const profileSchema = z.string().min(1).optional().describe("Profile name. Omit only when exactly one profile is configured.");
  const ticketFilterSchema = z.union([
    z.object({ field: z.literal("title"), op: z.literal("contains"), value: z.string().min(1).max(256) }).strict(),
    z.object({ field: z.literal("issueType"), op: z.literal("in"), values: z.array(z.string().min(1).max(128)).min(1).max(50) }).strict(),
    z.object({ field: z.literal("statusCategory"), op: z.enum(["in", "notIn"]), values: z.array(z.enum(["to_do", "in_progress", "done"])).min(1).max(3) }).strict(),
    z.object({ field: z.literal("assignee"), op: z.literal("in"), values: z.tuple([z.literal("me")]) }).strict(),
  ]);
  const searchWhereSchema = z.object({ all: z.array(ticketFilterSchema).min(1).max(16) }).strict();
  const searchPageSchema = z.object({ size: z.number().int().min(1).max(50).optional(), cursor: z.string().min(1).max(512).optional() }).strict();
  const searchScopeSchema = z.enum(["self", "project"]).describe("Ticket ownership scope. Defaults to self; use project only when the user explicitly requests all people or the whole project.");
  const searchStateSchema = z.enum(["open", "active", "done", "all"]).describe("Ticket status scope. Defaults to open; all includes completed tickets.");
  const searchQuerySchema = z.object({ scope: searchScopeSchema.optional(), state: searchStateSchema.optional(), where: searchWhereSchema.optional() }).strict();
  const invalidSearchInput = Symbol("invalid-ticket-search-input");
  const invalidTicketExportInput = Symbol("invalid-ticket-export-input");
  const ticketSearchInputSchema = z.object({
    profile: profileSchema,
    scope: searchScopeSchema.default("self"),
    state: searchStateSchema.default("open"),
    where: searchWhereSchema.optional(),
    page: searchPageSchema.optional(),
  }).strict().catch(() => invalidSearchInput as never);

  server.registerTool(
    "ticket_browser_connect",
    {
      title: "Open supervised ONES browser session",
      description: "Opens a fresh visible Chrome window for this browser profile. When autoLogin is configured, it submits the local direct-login credentials and immediately performs a read-only ONES authorization probe; the result explicitly reports whether the session is ready. MFA, CAPTCHA, SSO approval, and other challenges always require user action. The session stays only in this MCP process and is never exported or persisted.",
      inputSchema: { profile: profileSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    /** 处理浏览器连接请求并返回授权探测结果。 */
    async ({ profile }) => {
      try {
        return textResult({ ok: true, ...(await (await getApplication()).openBrowserSession(profile)) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "ticket_browser_disconnect",
    {
      title: "Close supervised ONES browser session",
      description: "Closes the temporary visible browser and discards its in-memory ONES session.",
      inputSchema: { profile: profileSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    /** 处理浏览器断开请求并丢弃当前会话。 */
    async ({ profile }) => {
      try {
        await (await getApplication()).closeBrowserSession(profile);
        return textResult({ ok: true, closed: true });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "ticket_connection_status",
    {
      title: "Ticket provider connection status",
      description: "Checks the selected ticket-provider profile and performs a small read-only ONES authorization probe.",
      inputSchema: { profile: profileSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    /** 处理连接状态探测请求。 */
    async ({ profile }) => {
      try {
        return textResult({ ok: true, ...(await (await getApplication()).connectionStatus(profile)) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "ticket_search",
    {
      title: "Search ticket work items",
      description: "Read-only list search. Use for 查看、查阅、查询、列出 or generic 获取 ONES 工单; it returns flat summaries only and never downloads details or writes local files. Defaults are scope=self and state=open; use state=all for the current user's complete history, and scope=project only for an explicit all-people or whole-project request. Supports only a one-level AND of title contains, issue-type IDs, and status categories. Results are fixed to createTime descending and nextCursor is an opaque server-issued token.",
      inputSchema: ticketSearchInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    /** 只将业务输入交给应用层；不向 MCP 暴露 ONES variables 或原始 continuation cursor。 */
    async (input) => {
      try {
        if ((input as unknown) === invalidSearchInput) {
          throw new TicketError("QUERY_INVALID", "ticket_search input does not match the V1 query schema");
        }
        const { profile, scope, state, where, page } = input;
        return textResult({ ok: true, ...(await (await getApplication()).searchTickets({ profile, scope, state, where, page })) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const ticketSchema = z.object({ id: z.string().min(1).max(128) }).strict();
  const ticketExportInputSchema = z.object({
    profile: profileSchema,
    ticket: ticketSchema.optional(),
    query: searchQuerySchema.optional(),
    selection: z.object({ expectedCount: z.number().int().min(0), fingerprint: z.string().regex(/^[a-f0-9]{64}$/i) }).strict().optional(),
    mode: z.enum(["plan", "write"]).default("plan").describe("plan is read-only; write commits a local bundle and requires confirmation"),
    media: z.enum(["metadata", "download"]).default("download").describe("download includes attachment-backed images and binaries during write; metadata writes no binary media"),
  }).strict().catch(() => invalidTicketExportInput as never);
  server.registerTool(
    "ticket_get",
    {
      title: "Get a ticket work item",
      description: "Reads one work item for 查看详情、查阅详情 or 获取某工单详情. Returns bounded details, comments and attachment metadata only; it never writes local files or downloads binary media. Use ticket_search for generic 查看/查阅列表 and ticket_export for 下载到本地/导出/保存到本地.",
      inputSchema: { profile: profileSchema, ticket: ticketSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    /** 处理单张工单详情读取请求，并投影为有界内联结果。 */
    async ({ profile, ticket }) => {
      try {
        return textResult({ ok: true, ticket: await (await getApplication()).getTicketInline(profile, ticket) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "ticket_export",
    {
      title: "Export a ticket work item",
      description: "Local export for 下载到本地、导出、保存到本地 or 获取到本地. It fetches complete normalized details including comments and attachment-backed images. Always call mode=plan first; only an explicitly confirmed mode=write writes bundles. Query writes require the selection fingerprint returned by a prior plan, enforce item/media budgets, and return completed and failed ticket IDs. Temporary ONES URLs are never returned or persisted.",
      inputSchema: ticketExportInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    /** 处理单张工单或冻结查询选择的导出计划/写入请求。 */
    async (input) => {
      try {
        if ((input as unknown) === invalidTicketExportInput) {
          throw new TicketError("QUERY_INVALID", "ticket_export input does not match the V1 export schema");
        }
        const { profile, ticket, query, selection, mode, media } = input;
        const app = await getApplication();
        if (ticket && query) throw new TicketError("QUERY_INVALID", "ticket_export accepts either ticket or query, not both");
        if (ticket) return textResult({ ok: true, export: await app.exportTicket(profile, ticket, mode, media) });
        if (query) return textResult({ ok: true, export: await app.exportTicketSearch(profile, query, mode, media, selection) });
        throw new TicketError("QUERY_INVALID", "ticket_export requires ticket or query");
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
