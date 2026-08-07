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
    "ticket_my_open_tasks",
    {
      title: "My open ticket tasks with complete details",
      description: "Reads every current-user, non-completed work item and its complete ONES detail bundle (description, status, assignee, priority, sprint, comments and attachment metadata). Parent rows are reported only as context and are not exported as work items.",
      inputSchema: { profile: profileSchema, limit: z.number().int().min(1).max(1_000).default(1_000), includeDetails: z.boolean().default(true) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    /** 处理当前用户未完成工单列表请求，可按参数获取完整详情。 */
    async ({ profile, limit, includeDetails }) => {
      try {
        const app = await getApplication();
        return textResult({ ok: true, ...(includeDetails ? await app.listMyOpenDetails(profile, limit) : await app.listMyOpen(profile, limit)) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const ticketSchema = z.object({ id: z.string().min(1).max(128) });
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
      description: "Plans or writes one normalized work item bundle locally. Write exports download media by default; temporary ONES URLs are never returned or persisted.",
      inputSchema: { profile: profileSchema, ticket: ticketSchema, mode: z.enum(["plan", "write"]).default("plan"), media: z.enum(["metadata", "download"]).default("download") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    /** 处理单张工单的导出计划或写入请求。 */
    async ({ profile, ticket, mode, media }) => {
      try {
        return textResult({ ok: true, export: await (await getApplication()).exportTicket(profile, ticket, mode, media) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "ticket_export_my_open_tasks",
    {
      title: "Export all my open ticket tasks",
      description: "Plans or writes local bundles for current-user, non-completed work items. `statuses` can select only named statuses such as 新建; write exports download media by default and resumes verified local media.",
      inputSchema: { profile: profileSchema, limit: z.number().int().min(1).max(1_000).default(1_000), mode: z.enum(["plan", "write"]).default("plan"), media: z.enum(["metadata", "download"]).default("download"), statuses: z.array(z.string().min(1).max(128)).max(20).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    /** 处理当前用户全部未完成工单的批量导出请求。 */
    async ({ profile, limit, mode, media, statuses }) => {
      try {
        return textResult({ ok: true, export: await (await getApplication()).exportMyOpenTickets(profile, limit, mode, media, statuses) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
