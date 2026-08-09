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
  const searchQuerySchema = z.object({ preset: z.enum(["my_open", "my_active", "all"]).optional(), where: searchWhereSchema.optional() }).strict();
  const invalidSearchInput = Symbol("invalid-ticket-search-input");
  const invalidTicketExportInput = Symbol("invalid-ticket-export-input");
  const ticketSearchInputSchema = z.object({
    profile: profileSchema,
    preset: z.enum(["my_open", "my_active", "all"]).default("my_open"),
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
      description: "Searches flat ticket summaries with the controlled my_open, my_active, or explicit all preset. Supports only a one-level AND of title contains, issue-type IDs, status categories, and assignee me. Results are fixed to createTime descending and nextCursor is an opaque server-issued token; raw ONES GraphQL, views, internal cursors, projects, other assignees, sorting, OR, and nested groups are rejected.",
      inputSchema: ticketSearchInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    /** 只将业务输入交给应用层；不向 MCP 暴露 ONES variables 或原始 continuation cursor。 */
    async (input) => {
      try {
        if ((input as unknown) === invalidSearchInput) {
          throw new TicketError("QUERY_INVALID", "ticket_search input does not match the V1 query schema");
        }
        const { profile, preset, where, page } = input;
        return textResult({ ok: true, ...(await (await getApplication()).searchTickets({ profile, preset, where, page })) });
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
    mode: z.enum(["plan", "write"]).default("plan"),
    media: z.enum(["metadata", "download"]).default("download"),
  }).strict().catch(() => invalidTicketExportInput as never);
  server.registerTool(
    "ticket_get",
    {
      title: "Get a ticket work item",
      description: "Reads one work item from the selected provider with details, message stream and attachment metadata.",
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
      description: "Plans or writes one normalized work item bundle, or a complete frozen ticket_search selection, locally. Query writes require the selection fingerprint returned by a prior plan. Write exports download media by default; temporary ONES URLs are never returned or persisted.",
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
