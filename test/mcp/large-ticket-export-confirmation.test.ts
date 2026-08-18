import assert from "node:assert/strict";
import { StaticTicketProfileResolver } from "../../src/config/static-ticket-profile-resolver.js";
import { TicketApplication } from "../../src/modules/tickets/application/ticket-application.js";
import { runBoundedWorkerPool } from "../../src/modules/tickets/application/bounded-worker-pool.js";
import { normalizeTicketExportLimits } from "../../src/modules/tickets/domain/ticket-export.js";
import { TicketError } from "../../src/modules/tickets/domain/ticket-error.js";
import { CanonicalTicket, TicketSummary } from "../../src/modules/tickets/domain/ticket.js";
import { BrowserSessionProvider, TicketBundleStore, TicketProfile, TicketProvider } from "../../src/modules/tickets/domain/ports.js";

const profile: TicketProfile = { name: "test", providerId: "ones", connector: "browser", allowedProjects: ["project-test"], inlineMaxChars: 12_000, maxConcurrent: 3 };

function summary(index: number, status = "Open"): TicketSummary {
  return { id: `ticket-${index}`, title: `Ticket ${index}`, projectId: "project-test", status: { name: status } };
}

function ticket(id: string): CanonicalTicket {
  return {
    schemaVersion: "1.0",
    source: { provider: "ones", product: "project", tenantBaseUrl: "https://tenant.example.test", teamId: "team-test", projectId: "project-test", ticketId: id, fetchedAt: "2026-08-18T00:00:00.000Z", connector: "browser" },
    classification: { value: "unclassified" }, title: id, comments: [], attachments: [], relations: [], customFields: [],
  };
}

class PagedProvider implements TicketProvider {
  readonly providerId = "ones";
  readonly searches: Array<{ size: number; after?: string }> = [];
  detailReads = 0;
  constructor(readonly summaries: readonly TicketSummary[]) {}
  async status() { return { configured: true, authorized: true, diagnostics: [] }; }
  async search(_profile: TicketProfile, query: { page: { size: number; after?: string } }) {
    this.searches.push({ size: query.page.size, after: query.page.after });
    const start = query.page.after ? Number(query.page.after) : 0;
    const items = this.summaries.slice(start, start + query.page.size);
    const next = start + items.length;
    return { items, page: { returned: items.length, totalCount: this.summaries.length, hasNextPage: next < this.summaries.length, ...(next < this.summaries.length ? { endCursor: String(next) } : {}) } };
  }
  async getTicket(_profile: TicketProfile, reference: { id?: string }) {
    this.detailReads += 1;
    return ticket(reference.id ?? "missing");
  }
}

function trackedBundleStore() {
  let begins = 0;
  let commits = 0;
  const store: TicketBundleStore = {
    async plan(item) { return { directory: `D:/plans/${item.source.ticketId}`, files: [], contentHash: item.source.ticketId, action: "created" as const }; },
    async beginExport(item) {
      begins += 1;
      return {
        missingMedia: [],
        async writeMedia() {},
        async commit() { commits += 1; return { directory: `D:/exports/${item.source.ticketId}`, files: [], contentHash: item.source.ticketId, action: "created" as const, exportId: item.source.ticketId, status: "created" as const }; },
        async abort() {},
      };
    },
  };
  return { store, counts: () => ({ begins, commits }) };
}

function application(provider: TicketProvider, bundleStore: TicketBundleStore, browserSessions?: BrowserSessionProvider) {
  return new TicketApplication({ profiles: new StaticTicketProfileResolver([profile]), provider, bundleStore, browserSessions, redaction: { omitPeople: false, removeFields: [] } });
}

async function confirmationFor(app: TicketApplication, query = { scope: "self" as const, state: "open" as const }, media: "metadata" | "download" = "metadata") {
  try {
    await app.exportTicketSearch("test", query, "write", media);
    throw new Error("Expected export confirmation");
  } catch (error) {
    assert.ok(error instanceof TicketError);
    assert.equal(error.code, "EXPORT_CONFIRMATION_REQUIRED");
    assert.ok(error.details?.confirmation);
    return error.details.confirmation;
  }
}

{
  const provider = new PagedProvider(Array.from({ length: 50 }, (_, index) => summary(index)));
  const tracked = trackedBundleStore();
  const result = await application(provider, tracked.store).exportTicketSearch("test", { scope: "self", state: "open" }, "write", "metadata");
  assert.equal(result.completedCount, 50, "50 items must still export directly");
  assert.deepEqual(tracked.counts(), { begins: 50, commits: 50 });
}

{
  const provider = new PagedProvider(Array.from({ length: 51 }, (_, index) => summary(index)));
  const tracked = trackedBundleStore();
  const app = application(provider, tracked.store);
  const confirmation = await confirmationFor(app);
  assert.equal(confirmation.selectedCount, 51);
  assert.equal(confirmation.autoDownloadThreshold, 50);
  assert.equal(confirmation.maxItems, 2_000);
  assert.equal(provider.detailReads, 0, "preflight must not fetch details");
  assert.deepEqual(tracked.counts(), { begins: 0, commits: 0 }, "preflight must not write");
  const complete = await app.exportTicketSearch("test", { scope: "self", state: "open" }, "write", "metadata", confirmation.selection);
  assert.equal(complete.completedCount, 51, "confirmation must export the complete frozen selection");
  assert.deepEqual(tracked.counts(), { begins: 51, commits: 51 });
}

{
  const provider = new PagedProvider(Array.from({ length: 200 }, (_, index) => summary(index)));
  const tracked = trackedBundleStore();
  const app = application(provider, tracked.store);
  const confirmation = await confirmationFor(app);
  assert.equal(provider.searches.length, 4, "200 items must preflight through four 50-item pages");
  assert.ok(provider.searches.every((query) => query.size === 50));
  const complete = await app.exportTicketSearch("test", { scope: "self", state: "open" }, "write", "metadata", confirmation.selection);
  assert.equal(complete.completedCount, 200);
  assert.equal(provider.searches.length, 8, "confirmation must re-enumerate all pages");
  assert.deepEqual(tracked.counts(), { begins: 200, commits: 200 });
}

{
  const provider = new PagedProvider(Array.from({ length: 200 }, (_, index) => summary(index)));
  const tracked = trackedBundleStore();
  let authorized = false;
  let opens = 0;
  let closes = 0;
  provider.getTicket = async (_profile, reference) => {
    provider.detailReads += 1;
    if (!authorized) throw new TicketError("SOURCE_UNAUTHORIZED", "browser authorization expired");
    return ticket(reference.id ?? "missing");
  };
  const sessions: BrowserSessionProvider = {
    async openBrowserSession() {
      opens += 1;
      authorized = true;
      return { url: "https://tenant.example.test", message: "authorized", authentication: { mode: "auto", authorized: true, state: "authorized", diagnostics: [] }, created: true };
    },
    async closeBrowserSession() { closes += 1; },
  };
  const app = application(provider, tracked.store, sessions);
  const confirmation = await confirmationFor(app);
  const complete = await app.withBrowserAuthRecovery("test", () => app.exportTicketSearch("test", { scope: "self", state: "open" }, "write", "metadata", confirmation.selection));
  assert.equal(complete.completedCount, 200);
  assert.equal(opens, 1, "a confirmed batch must open at most one automatic session for recovery");
  assert.equal(closes, 1, "the automatic session must close once after the whole confirmed batch");
}

{
  const provider = new PagedProvider(Array.from({ length: 2_000 }, (_, index) => summary(index)));
  const tracked = trackedBundleStore();
  const confirmation = await confirmationFor(application(provider, tracked.store));
  assert.equal(confirmation.selectedCount, 2_000);
  assert.equal(provider.searches.length, 40, "2,000 items must enumerate all forty pages before confirmation");
  assert.equal(provider.detailReads, 0);
  assert.deepEqual(tracked.counts(), { begins: 0, commits: 0 });
}

{
  const provider = new PagedProvider(Array.from({ length: 2_001 }, (_, index) => summary(index)));
  const tracked = trackedBundleStore();
  await assert.rejects(
    () => application(provider, tracked.store).exportTicketSearch("test", { scope: "self", state: "open" }, "write", "metadata"),
    (error: unknown) => error instanceof TicketError && error.code === "EXPORT_LIMIT_EXCEEDED",
  );
  assert.equal(provider.detailReads, 0);
  assert.deepEqual(tracked.counts(), { begins: 0, commits: 0 });
}

{
  const provider = new PagedProvider(Array.from({ length: 51 }, (_, index) => summary(index, index === 50 ? "Closed" : "Open")));
  const tracked = trackedBundleStore();
  const result = await application(provider, tracked.store).exportTicketSearch("test", { scope: "self", state: "open", statuses: ["Open"] }, "write", "metadata");
  assert.equal(result.completedCount, 50, "threshold must apply after display-status filtering");
}

{
  const provider = new PagedProvider(Array.from({ length: 51 }, (_, index) => summary(index)));
  const tracked = trackedBundleStore();
  const app = application(provider, tracked.store);
  const confirmation = await confirmationFor(app);
  await assert.rejects(
    () => app.exportTicketSearch("test", { scope: "self", state: "open" }, "write", "download", confirmation.selection),
    (error: unknown) => error instanceof TicketError && error.code === "SELECTION_CHANGED",
    "selection must be bound to media mode",
  );
  assert.deepEqual(tracked.counts(), { begins: 0, commits: 0 });
}

assert.throws(
  () => normalizeTicketExportLimits({ maxItems: 2_001 }),
  (error: unknown) => error instanceof TicketError && error.code === "CONFIG_INVALID",
  "configuration must reject an unsafe maxItems value instead of clamping it",
);

{
  const started: number[] = [];
  const settled: number[] = [];
  await assert.rejects(
    () => runBoundedWorkerPool([0, 1, 2, 3, 4], 3, async (value) => {
      started.push(value);
      if (value === 0) throw new TicketError("SOURCE_UNAUTHORIZED", "expired");
      await new Promise((resolve) => setTimeout(resolve, 5));
      settled.push(value);
      return value;
    }),
    (error: unknown) => error instanceof TicketError && error.code === "SOURCE_UNAUTHORIZED",
  );
  assert.deepEqual(started, [0, 1, 2], "authorization failure must stop replacement workers");
  assert.deepEqual(settled, [1, 2], "the pool must wait for in-flight workers before retry can begin");
}

console.log("Large ticket export confirmation tests passed.");
