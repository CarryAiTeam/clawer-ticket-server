import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StaticTicketProfileResolver } from "../../src/config/static-ticket-profile-resolver.js";
import { TicketApplication } from "../../src/modules/tickets/application/ticket-application.js";
import { TicketBundleStore, TicketProvider } from "../../src/modules/tickets/domain/ports.js";
import { CanonicalTicket, TicketIndexTree } from "../../src/modules/tickets/domain/ticket.js";
import { createServer } from "../../src/bootstrap/create-server.js";

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const profiles = new StaticTicketProfileResolver([{ name: "test", providerId: "ones", connector: "graphql", allowedProjects: [], inlineMaxChars: 12_000 }]);
const ticket: CanonicalTicket = {
  schemaVersion: "1.0",
  source: { provider: "ones", product: "project", tenantBaseUrl: "https://tenant.example.test", teamId: "team-test", ticketId: "task-test", fetchedAt: "2026-08-03T00:00:00.000Z", connector: "graphql" },
  classification: { value: "unclassified" }, title: "Smoke ticket", comments: [], attachments: [], relations: [], customFields: [],
};
const provider: TicketProvider = {
  providerId: "ones",
  async status() { return { configured: true, authorized: true, diagnostics: [] }; },
  async listMyOpen(): Promise<TicketIndexTree> { return { view: "my_open_tree", items: [], roots: [], externalParentIds: [], page: { count: 0, matchedCount: 0, contextCount: 0, hasNextPage: false } }; },
  async getTicket() { return ticket; },
};
const bundleStore: TicketBundleStore = {
  async plan() { return { directory: "D:/ones-test-exports", files: [], contentHash: "test", action: "created" }; },
  async beginExport() {
    return {
      missingMedia: [],
      async writeMedia() {},
      async commit() { return { directory: "D:/ones-test-exports", files: [], contentHash: "test", action: "created" as const, exportId: "test", status: "created" as const }; },
      async abort() {},
    };
  },
};
const server = createServer({ application: new TicketApplication({ profiles, provider, bundleStore, redaction: { omitPeople: false, removeFields: [] } }) });
const client = new Client({ name: "smoke-test", version: "1.0.0" });

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  for (const name of ["ticket_browser_connect", "ticket_browser_disconnect", "ticket_connection_status", "ticket_my_open_tasks", "ticket_get", "ticket_export", "ticket_export_my_open_tasks"]) {
    assert.ok(tools.some((tool) => tool.name === name), `${name} tool must be registered`);
  }
  for (const [name, args] of [
    ["ticket_connection_status", { profile: "test" }],
    ["ticket_my_open_tasks", { profile: "test", limit: 5 }],
    ["ticket_get", { profile: "test", ticket: { id: "task-test" } }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, `${name} must succeed`);
  }
  const mediaExport = await client.callTool({ name: "ticket_export", arguments: { profile: "test", ticket: { id: "task-test" }, mode: "plan" } });
  assert.equal(mediaExport.isError, undefined, "ticket_export must default media to download");

  console.log("MCP smoke test passed.");
} finally {
  await clientTransport.close();
  await serverTransport.close();
}
