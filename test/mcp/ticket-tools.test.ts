import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StaticTicketProfileResolver } from "../../src/config/static-ticket-profile-resolver.js";
import { TicketApplication } from "../../src/modules/tickets/application/ticket-application.js";
import { BrowserSessionProvider, TicketBundleStore, TicketProvider } from "../../src/modules/tickets/domain/ports.js";
import { CanonicalTicket, TicketIndexTree } from "../../src/modules/tickets/domain/ticket.js";
import { createServer } from "../../src/bootstrap/create-server.js";

function responseText(result: { content: readonly unknown[] }): string {
  const first = result.content[0];
  if (!first || typeof first !== "object" || !("text" in first) || typeof first.text !== "string") throw new Error("Expected an MCP text response");
  return first.text;
}

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const profiles = new StaticTicketProfileResolver([{ name: "test", providerId: "ones", connector: "graphql", allowedProjects: [], inlineMaxChars: 12_000 }]);
const ticket: CanonicalTicket = {
  schemaVersion: "1.0",
  source: { provider: "ones", product: "project", tenantBaseUrl: "https://tenant.example.test", teamId: "team-test", ticketId: "task-test", fetchedAt: "2026-08-03T00:00:00.000Z", connector: "graphql" },
  classification: { value: "unclassified" }, title: "Smoke ticket", comments: [], attachments: [], relations: [], customFields: [],
};
const provider: TicketProvider = {
  providerId: "ones",
  async status(profile) { return { configured: true, authorized: true, diagnostics: [profile.name] }; },
  async listMyOpen(): Promise<TicketIndexTree> { return { view: "my_open_tree", items: [], roots: [], externalParentIds: [], page: { count: 0, matchedCount: 0, contextCount: 0, hasNextPage: false } }; },
  async getTicket() { return ticket; },
};
const browserSessions: BrowserSessionProvider = {
  async openBrowserSession() {
    return { url: "https://tenant.example.test", message: "connected", authentication: { mode: "manual", authorized: true, diagnostics: [] } };
  },
  async closeBrowserSession() {},
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
const server = createServer({ application: new TicketApplication({ profiles, provider, browserSessions, bundleStore, redaction: { omitPeople: false, removeFields: [] } }) });
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

  for (const [name, args] of [
    ["ticket_browser_connect", {}],
    ["ticket_browser_disconnect", {}],
    ["ticket_connection_status", {}],
    ["ticket_my_open_tasks", { limit: 5 }],
    ["ticket_get", { ticket: { id: "task-test" } }],
    ["ticket_export", { ticket: { id: "task-test" }, mode: "plan" }],
    ["ticket_export_my_open_tasks", { limit: 5, mode: "plan" }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, `${name} must resolve the only configured profile when profile is omitted`);
  }
  const implicitStatus = await client.callTool({ name: "ticket_connection_status", arguments: {} });
  assert.match(responseText(implicitStatus), /"profile":\s*"test"/, "connection status must report the profile selected implicitly");

  const multiProfiles = new StaticTicketProfileResolver([
    { name: "first", providerId: "ones", connector: "graphql", allowedProjects: [], inlineMaxChars: 12_000 },
    { name: "second", providerId: "ones", connector: "graphql", allowedProjects: [], inlineMaxChars: 12_000 },
  ]);
  const multiServer = createServer({ application: new TicketApplication({ profiles: multiProfiles, provider, bundleStore, redaction: { omitPeople: false, removeFields: [] } }) });
  const [multiClientTransport, multiServerTransport] = InMemoryTransport.createLinkedPair();
  const multiClient = new Client({ name: "multi-profile-smoke-test", version: "1.0.0" });
  try {
    await multiServer.connect(multiServerTransport);
    await multiClient.connect(multiClientTransport);
    const missingProfile = await multiClient.callTool({ name: "ticket_connection_status", arguments: {} });
    assert.equal(missingProfile.isError, true, "multiple profiles must not choose one implicitly");
    assert.match(responseText(missingProfile), /PROFILE_REQUIRED/, "multiple profiles must return a stable selection error");
    assert.match(responseText(missingProfile), /first, second/, "the selection error must identify the available profiles");

    const explicitProfile = await multiClient.callTool({ name: "ticket_connection_status", arguments: { profile: "second" } });
    assert.equal(explicitProfile.isError, undefined, "an explicit profile must continue to work with multiple configured profiles");
    assert.match(responseText(explicitProfile), /"profile":\s*"second"/);

    const unknownProfile = await multiClient.callTool({ name: "ticket_connection_status", arguments: { profile: "missing" } });
    assert.equal(unknownProfile.isError, true, "an unknown profile must still fail");
    assert.match(responseText(unknownProfile), /PROFILE_NOT_FOUND/);
  } finally {
    await multiClientTransport.close();
    await multiServerTransport.close();
  }

  console.log("MCP smoke test passed.");
} finally {
  await clientTransport.close();
  await serverTransport.close();
}
