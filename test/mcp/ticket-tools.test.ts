import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StaticTicketProfileResolver } from "../../src/config/static-ticket-profile-resolver.js";
import { TicketApplication } from "../../src/modules/tickets/application/ticket-application.js";
import { BrowserSessionProvider, TicketBundleStore, TicketProvider } from "../../src/modules/tickets/domain/ports.js";
import { CanonicalTicket, TicketSearchQuery } from "../../src/modules/tickets/domain/ticket.js";
import { createServer } from "../../src/bootstrap/create-server.js";

function responseText(result: { content: readonly unknown[] }): string {
  const first = result.content[0];
  if (!first || typeof first !== "object" || !("text" in first) || typeof first.text !== "string") throw new Error("Expected an MCP text response");
  return first.text;
}

function responseJson(result: { content: readonly unknown[] }): Record<string, unknown> {
  return JSON.parse(responseText(result)) as Record<string, unknown>;
}

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const profiles = new StaticTicketProfileResolver([{ name: "test", providerId: "ones", connector: "graphql", allowedProjects: ["project-test"], inlineMaxChars: 12_000 }]);
const ticket: CanonicalTicket = {
  schemaVersion: "1.0",
  source: { provider: "ones", product: "project", tenantBaseUrl: "https://tenant.example.test", teamId: "team-test", projectId: "project-test", ticketId: "task-test", fetchedAt: "2026-08-03T00:00:00.000Z", connector: "graphql" },
  classification: { value: "unclassified" }, title: "Smoke ticket", comments: [], attachments: [], relations: [], customFields: [],
};
const searchQueries: TicketSearchQuery[] = [];
const provider: TicketProvider = {
  providerId: "ones",
  async status(profile) { return { configured: true, authorized: true, diagnostics: [profile.name] }; },
  async search(_profile, query) {
    searchQueries.push(structuredClone(query));
    if (query.page.after) {
      assert.equal(query.page.after, "provider-after-1", "the application must unwrap the provider cursor only after validating its public token");
      return {
        items: [{ id: "task-search-2", key: "T-2", title: "Second result", status: { category: "in_progress" }, projectId: "project-test" }],
        page: { returned: 1, totalCount: 2, hasNextPage: false },
      };
    }
    return {
      items: [{ id: "task-search-1", key: "T-1", title: "First result", status: { category: "to_do" }, projectId: "project-test" }],
      page: { returned: 1, totalCount: 2, hasNextPage: true, endCursor: "provider-after-1" },
    };
  },
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
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["ticket_browser_connect", "ticket_browser_disconnect", "ticket_connection_status", "ticket_export", "ticket_get", "ticket_search"].sort(),
    "V1 must expose exactly the six normative tools",
  );
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.match(byName.get("ticket_search")?.description ?? "", /Read-only list search/);
  assert.match(byName.get("ticket_search")?.description ?? "", /获取 ONES/);
  assert.match(byName.get("ticket_get")?.description ?? "", /never writes local files/);
  assert.match(byName.get("ticket_export")?.description ?? "", /Local export/);
  assert.match(byName.get("ticket_export")?.description ?? "", /mode=plan first/);
  for (const [name, args] of [
    ["ticket_connection_status", { profile: "test" }],
    ["ticket_get", { profile: "test", ticket: { id: "task-test" } }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, `${name} must succeed`);
  }
  const mediaExport = await client.callTool({ name: "ticket_export", arguments: { profile: "test", ticket: { id: "task-test" }, mode: "plan" } });
  assert.equal(mediaExport.isError, undefined, "ticket_export must default media to download");
  const mediaExportPayload = responseJson(mediaExport);
  const singleExportBudget = (mediaExportPayload.export as { budget: { mediaMode: string; limits: { maxItems: number } } }).budget;
  assert.equal(singleExportBudget.mediaMode, "download");
  assert.equal(singleExportBudget.limits.maxItems, 50);

  const firstSearch = await client.callTool({
    name: "ticket_search",
    arguments: {
      profile: "test",
      scope: "self",
      state: "active",
      where: { all: [{ field: "title", op: "contains", value: "  launch  " }, { field: "issueType", op: "in", values: ["type-a"] }] },
      page: { size: 1 },
    },
  });
  assert.equal(firstSearch.isError, undefined, "ticket_search must accept the frozen v1 filter surface");
  const firstSearchPayload = responseJson(firstSearch);
  const firstPage = firstSearchPayload.page as { nextCursor?: string; totalCount?: number; totalCountExact?: boolean };
  assert.equal(firstPage.totalCount, 2);
  assert.equal(firstPage.totalCountExact, true);
  assert.ok(firstPage.nextCursor && !firstPage.nextCursor.includes("provider-after-1"), "public cursors must not expose ONES after values");
  assert.deepEqual(searchQueries[0]?.filter.all, [
    { field: "title", op: "contains", value: "launch" },
    { field: "issueType", op: "in", values: ["type-a"] },
    { field: "statusCategory", op: "in", values: ["to_do", "in_progress"] },
    { field: "assignee", op: "in", values: ["me"] },
  ]);
  assert.deepEqual(searchQueries[0]?.sort, { field: "createTime", direction: "desc" });

  const secondSearch = await client.callTool({
    name: "ticket_search",
    arguments: {
      profile: "test",
      scope: "self",
      state: "active",
      where: { all: [{ field: "title", op: "contains", value: "launch" }, { field: "issueType", op: "in", values: ["type-a"] }] },
      page: { size: 1, cursor: firstPage.nextCursor },
    },
  });
  assert.equal(secondSearch.isError, undefined, "a cursor may continue only the same normalized query");
  assert.equal(searchQueries[1]?.page.after, "provider-after-1");

  const crossQueryCursor = await client.callTool({
    name: "ticket_search",
    arguments: { profile: "test", scope: "self", state: "open", page: { size: 1, cursor: firstPage.nextCursor } },
  });
  assert.equal(crossQueryCursor.isError, true, "a cursor must not be reusable with another scope or state");
  assert.match(responseText(crossQueryCursor), /QUERY_CURSOR_INVALID/);

  const unsupportedSearch = await client.callTool({
    name: "ticket_search",
    arguments: { profile: "test", scope: "project", state: "all", where: { all: [{ field: "project", op: "in", values: ["project-a"] }] } },
  });
  assert.equal(unsupportedSearch.isError, true, "v1 must reject public project filters");
  assert.match(responseText(unsupportedSearch), /QUERY_INVALID/, "schema rejection must use the stable domain error code");
  const rawOnesSearch = await client.callTool({
    name: "ticket_search",
    arguments: { profile: "test", filterGroup: [{ assign_in: ["$currentUser"] }] },
  });
  assert.equal(rawOnesSearch.isError, true, "v1 must reject raw ONES filterGroup input instead of silently stripping it");
  assert.match(responseText(rawOnesSearch), /QUERY_INVALID/, "raw ONES input must use the stable domain error code");
  const unsupportedExportQuery = await client.callTool({
    name: "ticket_export",
    arguments: { profile: "test", query: { scope: "project", state: "all", where: { all: [{ field: "project", op: "in", values: ["project-a"] }] } }, mode: "plan" },
  });
  assert.equal(unsupportedExportQuery.isError, true, "ticket_export must reject the same unsupported query filters as ticket_search");
  assert.match(responseText(unsupportedExportQuery), /QUERY_INVALID/, "ticket_export schema rejection must use the stable domain error code");

  const queryExportPlan = await client.callTool({ name: "ticket_export", arguments: { profile: "test", query: { scope: "self", state: "active" }, mode: "plan", media: "metadata" } });
  assert.equal(queryExportPlan.isError, undefined, "ticket_export must plan a complete query selection");
  const queryExportPayload = responseJson(queryExportPlan);
  const queryExport = queryExportPayload.export as { query: { scope: string; state: string }; selection: { expectedCount: number; fingerprint: string }; budget: { plannedMedia: { plannedCount: number }; limits: { maxAttachments: number } } };
  assert.equal(queryExport.query.scope, "self");
  assert.equal(queryExport.query.state, "active");
  assert.equal(queryExport.selection.expectedCount, 2);
  assert.equal(queryExport.budget.plannedMedia.plannedCount, 0);
  assert.equal(queryExport.budget.limits.maxAttachments, 500);
  const changedSelection = await client.callTool({
    name: "ticket_export",
    arguments: { profile: "test", query: { scope: "self", state: "active" }, mode: "write", media: "metadata", selection: { expectedCount: 2, fingerprint: "0".repeat(64) } },
  });
  assert.equal(changedSelection.isError, true, "query write must reject a changed or forged frozen selection");
  assert.match(responseText(changedSelection), /SELECTION_CHANGED/);
  const queryExportWrite = await client.callTool({
    name: "ticket_export",
    arguments: { profile: "test", query: { scope: "self", state: "active" }, mode: "write", media: "metadata", selection: queryExport.selection },
  });
  assert.equal(queryExportWrite.isError, undefined, "query write must accept the exact selection returned by plan");

  const defaultQueryExport = await client.callTool({ name: "ticket_export", arguments: { profile: "test", query: {}, mode: "plan", media: "metadata" } });
  assert.equal(defaultQueryExport.isError, undefined, "query exports must share ticket_search defaults");
  const defaultQueryExportPayload = responseJson(defaultQueryExport);
  const defaultExportQuery = (defaultQueryExportPayload.export as { query: { scope: string; state: string } }).query;
  assert.equal(defaultExportQuery.scope, "self");
  assert.equal(defaultExportQuery.state, "open");
  assert.deepEqual(searchQueries.at(-1)?.filter.all, [
    { field: "statusCategory", op: "notIn", values: ["done"] },
    { field: "assignee", op: "in", values: ["me"] },
  ]);

  const defaultSearch = await client.callTool({ name: "ticket_search", arguments: { profile: "test" } });
  assert.equal(defaultSearch.isError, undefined, "ticket_search must default to the current user's open tickets");
  const defaultSearchPayload = responseJson(defaultSearch);
  const defaultQuery = defaultSearchPayload.query as { scope: string; state: string; normalizedFilter: { all: unknown[] }; fingerprint: string };
  assert.equal(defaultQuery.scope, "self");
  assert.equal(defaultQuery.state, "open");
  assert.deepEqual(defaultQuery.normalizedFilter, {
    all: [
      { field: "statusCategory", op: "notIn", values: ["done"] },
      { field: "assignee", op: "in", values: ["me"] },
    ],
  });
  assert.match(defaultQuery.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(searchQueries.at(-1)?.filter.all, [
    { field: "statusCategory", op: "notIn", values: ["done"] },
    { field: "assignee", op: "in", values: ["me"] },
  ]);
  const selfAllSearch = await client.callTool({ name: "ticket_search", arguments: { profile: "test", scope: "self", state: "all" } });
  assert.equal(selfAllSearch.isError, undefined, "state=all must retain the current-user scope by default");
  assert.deepEqual(searchQueries.at(-1)?.filter.all, [
    { field: "assignee", op: "in", values: ["me"] },
  ]);
  const projectAllSearch = await client.callTool({ name: "ticket_search", arguments: { profile: "test", scope: "project", state: "all" } });
  assert.equal(projectAllSearch.isError, undefined, "project scope must be explicit");
  assert.deepEqual(searchQueries.at(-1)?.filter.all, [], "project all must not inherit current-user or status conditions; the provider receives the profile allowlist separately");
  const contradictoryScope = await client.callTool({
    name: "ticket_search",
    arguments: { profile: "test", scope: "project", where: { all: [{ field: "assignee", op: "in", values: ["me"] }] } },
  });
  assert.equal(contradictoryScope.isError, true, "project scope must reject a current-user assignee condition");
  assert.match(responseText(contradictoryScope), /QUERY_INVALID/);

  const profileWithoutProjectAllowlist = new StaticTicketProfileResolver([{ name: "unrestricted", providerId: "ones", connector: "graphql", allowedProjects: [], inlineMaxChars: 12_000 }]);
  const unrestrictedServer = createServer({ application: new TicketApplication({ profiles: profileWithoutProjectAllowlist, provider, bundleStore, redaction: { omitPeople: false, removeFields: [] } }) });
  const [unrestrictedClientTransport, unrestrictedServerTransport] = InMemoryTransport.createLinkedPair();
  const unrestrictedClient = new Client({ name: "unrestricted-profile-test", version: "1.0.0" });
  try {
    await unrestrictedServer.connect(unrestrictedServerTransport);
    await unrestrictedClient.connect(unrestrictedClientTransport);
    const missingProjectAllowlist = await unrestrictedClient.callTool({ name: "ticket_search", arguments: { profile: "unrestricted", scope: "project", state: "all" } });
    assert.equal(missingProjectAllowlist.isError, true, "project scope must not run with an empty profile allowlist");
    assert.match(responseText(missingProjectAllowlist), /SOURCE_NOT_ALLOWED/);
  } finally {
    await unrestrictedClientTransport.close();
    await unrestrictedServerTransport.close();
  }

  const limitedApplication = new TicketApplication({
    profiles,
    provider,
    bundleStore,
    redaction: { omitPeople: false, removeFields: [] },
    exportLimits: { maxItems: 1 },
  });
  await assert.rejects(
    () => limitedApplication.exportTicketSearch("test", { scope: "self", state: "open" }, "plan", "metadata"),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "EXPORT_LIMIT_EXCEEDED"),
    "query exports must reject a selection larger than the configured item budget",
  );
  for (const [name, args] of [
    ["ticket_browser_connect", {}],
    ["ticket_browser_disconnect", {}],
    ["ticket_connection_status", {}],
    ["ticket_get", { ticket: { id: "task-test" } }],
    ["ticket_export", { ticket: { id: "task-test" }, mode: "plan" }],
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
