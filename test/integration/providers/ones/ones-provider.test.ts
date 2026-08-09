import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { StaticTicketProfileResolver } from "../../../../src/config/static-ticket-profile-resolver.js";
import { TicketApplication, projectTicketForInline } from "../../../../src/modules/tickets/application/ticket-application.js";
import { OnesConfig, parseConfig } from "../../../../src/providers/ones/ones-config.js";
import { HttpClient, HttpRequest, HttpResponse, parseJsonResponse } from "../../../../src/infrastructure/http/fetch-http-client.js";
import { TicketSearchQuery } from "../../../../src/modules/tickets/domain/ticket.js";
import { TicketBundleStore, TicketProfile, TicketProvider } from "../../../../src/modules/tickets/domain/ports.js";
import { compileOnesTicketSearchVariables, OnesGraphqlSource } from "../../../../src/providers/ones/ones-graphql-source.js";
import { OnesBrowserSource } from "../../../../src/providers/ones/ones-browser-source.js";
import { OnesRawTicketData } from "../../../../src/providers/ones/ones-contracts.js";
import { normalizeOnesTicket } from "../../../../src/providers/ones/ones-ticket-mapper.js";
import { SecretProvider } from "../../../../src/infrastructure/security/env-secret-provider.js";
import { LocalTicketBundleStore, removeTestDirectory } from "../../../../src/modules/tickets/infrastructure/export/local-ticket-bundle-store.js";

const root = await mkdtemp(join(tmpdir(), "ones-ticket-mcp-"));
const config: OnesConfig = {
  schemaVersion: "1.0",
  storage: { root, retainRawSource: false, redaction: { omitPeople: false, removeFields: ["phone", "email"] } },
  profiles: {
    demo: {
      provider: "ones",
      source: "graphql",
      product: "project",
      baseUrl: "https://tenant.example.test",
      teamId: "team-demo",
      allowedHosts: ["tenant.example.test"],
      allowedProjects: ["project-demo"],
      secretRef: "ONES_TEST_TOKEN",
      authentication: { headerName: "Authorization", scheme: "Bearer" },
      requestBudget: { maxConcurrent: 1, maxRequestsPerMinute: 20 },
      inlineMaxChars: 12_000,
      classificationRules: [{ name: "tech", field: "issueType", equals: "技术故事", class: "technical-change" }],
    },
  },
};

const rawTicket: OnesRawTicketData = {
  detail: {
    uuid: "task-1",
    key: "P-1",
    name: "示例技术改造",
    description: "<p>安全描述<a href=\"https://tenant.example.test/api/project/file/attachment/abc?token=temporary\">a.png</a><img alt=\"描述图\" data-uuid=\"attachment-1\" data-mime=\"image/png\" src=\"https://tenant.example.test/api/project/file/attachment/abc?token=temporary\"><br><img alt=\"重复描述图\" data-uuid=\"attachment-1\" data-mime=\"image/png\" src=\"https://tenant.example.test/api/project/file/attachment/abc?token=temporary\"></p>",
    descriptionText: "安全描述",
    status: { name: "进行中" },
    priority: { name: "高" },
    sprint: { uuid: "sprint-1", name: "迭代 A", planStartTime: "2026-01-01", planEndTime: "2026-01-15" },
    assign: { uuid: "user-1", name: "开发者" },
    owner: { uuid: "user-2", name: "创建者" },
    issueType: { name: "技术故事" },
    parent: { uuid: "parent-1", key: "P-0", name: "父任务" },
    subTasks: [{ uuid: "child-1", key: "P-2", name: "子任务" }],
    relatedTasks: [{ uuid: "related-1", key: "P-3", name: "关联任务" }],
    project: { uuid: "project-demo", name: "示例项目" },
    importantField: [
      { fieldUUID: "field-id", name: "ID", value: "#209161" },
      { fieldUUID: "field038", name: "严重程度", value: "提示" },
      { fieldUUID: "field004", name: "负责人", value: "开发者" },
      { fieldUUID: "email", name: "email", value: "private@example.test" },
    ],
    attachments: [{ uuid: "attachment-1", name: "a.png", mime: "image/png", size: 12, hash: "abc" }],
  },
  messages: { messages: [
    { uuid: "message-1", from: { uuid: "user-1", name: "开发者" }, send_time: "2026-01-01", action: "comment", ext: { content: "<p>已处理 <a href=\"https://docs.example.test/guide?tracking=private\">实施说明</a><img alt=\"进度图\" src=\"https://cdn.example.test/image.png\"></p>" } },
    { uuid: "discussion-1", type: "discussion", from: "user-1", from_name: "开发者", sendTime: "2026-01-02", rich_text: "<p>真实评论正文<img alt=\"评论附件\" data-ref-id=\"attachment-1\" data-mime=\"image/png\" src=\"https://tenant.example.test/api/project/file/attachment/abc\"></p>" },
    { uuid: "resource-1", type: "resource", from_name: "开发者", sendTime: "2026-01-03", resource: { uuid: "attachment-1", name: "评论上传.png", mime: "image/png", size: 12 } },
    { uuid: "activity-1", type: "update", from_name: "开发者", sendTime: "2026-01-04", object_name: "状态", ext: { old_value: "新建", new_value: "已确认" } },
  ] },
  attachments: { attachments: [{ uuid: "attachment-1", name: "a.png", mime: "image/png", size: 12, hash: "abc" }] },
};

function ticketProfile(config: OnesConfig, name = "demo"): TicketProfile {
  const profile = config.profiles[name]!;
  return { name, providerId: profile.provider, connector: profile.source, allowedProjects: profile.allowedProjects, inlineMaxChars: profile.inlineMaxChars };
}

function createApplication(config: OnesConfig, provider: TicketProvider, bundleStore: LocalTicketBundleStore, browserSessions?: OnesBrowserSource): TicketApplication {
  return new TicketApplication({
    profiles: new StaticTicketProfileResolver(Object.keys(config.profiles).map((name) => ticketProfile(config, name))),
    provider,
    bundleStore,
    redaction: config.storage.redaction,
    browserSessions,
  });
}

class FakeProvider implements TicketProvider {
  readonly providerId = "ones";
  async status() { return { configured: true, authorized: true, diagnostics: ["fake"] }; }
  async search() {
    return {
      items: [{ id: "task-1", title: "示例技术改造", assignee: { id: "user-1", displayName: "开发者" }, projectId: "project-demo" }],
      page: { returned: 1, totalCount: 1, hasNextPage: false },
    };
  }
  async getTicket(profile: TicketProfile) { return normalizeOnesTicket(config.profiles[profile.name]!, rawTicket); }
}

class StaticSecretProvider implements SecretProvider {
  async resolve(): Promise<string> { return "test-token"; }
}

class RecordingHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly rejectDetail = false, private readonly rejectRest = false) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const body = request.body ?? "";
    if (request.url.pathname.endsWith("/items/graphql") && body.includes("buckets")) {
      const payload = JSON.parse(body) as { variables?: { pagination?: { after?: string } } };
      const after = payload.variables?.pagination?.after;
      const task = after
        ? { uuid: "task-2", key: "P-2", name: "续页标题", number: 2, project: { uuid: "project-demo" }, status: { uuid: "status-2", name: "进行中", category: "in_progress" }, assign: { uuid: "user-1", name: "开发者" } }
        : { uuid: "task-1", key: "P-1", name: "标题", number: 1, project: { uuid: "project-demo" }, status: { uuid: "status-1", name: "未开始", category: "to_do" }, assign: { uuid: "user-1", name: "开发者" } };
      return response({ data: { buckets: [{ tasks: [task], pageInfo: after
        ? { count: 1, totalCount: 2, startCursor: "cursor-2", endCursor: "cursor-2", hasNextPage: false }
        : { count: 1, totalCount: 2, startCursor: "cursor-1", endCursor: "cursor-1", hasNextPage: true } }] } });
    }
    if (request.url.pathname.endsWith("/items/graphql")) return this.rejectDetail ? response({ error: "detail rejected" }, 400) : response({ data: { task: rawTicket.detail } });
    if (request.url.pathname.endsWith("/messages")) return this.rejectRest ? response({ error: "messages rejected" }, 400) : response(rawTicket.messages);
    if (request.url.pathname.includes("/attachments")) return this.rejectRest ? response({ error: "attachments rejected" }, 400) : response(rawTicket.attachments);
    throw new Error(`Unexpected path ${request.url.pathname}`);
  }
}

class ControlledClockSource extends OnesGraphqlSource {
  current = 0;
  readonly waits: number[] = [];

  protected override now(): number {
    return this.current;
  }

  protected override async delay(milliseconds: number): Promise<void> {
    this.waits.push(milliseconds);
    this.current += milliseconds;
  }
}

class RetryOnceHttpClient extends RecordingHttpClient {
  private retried = false;

  override async request(request: HttpRequest): Promise<HttpResponse> {
    if (!this.retried) {
      this.retried = true;
      this.requests.push(request);
      return { status: 429, headers: new Headers({ "content-type": "application/json", "retry-after": "2" }), text: JSON.stringify({ error: "slow down" }) };
    }
    return super.request(request);
  }
}

class MissingHasNextPageHttpClient implements HttpClient {
  async request(): Promise<HttpResponse> {
    return response({ data: { buckets: [{ tasks: [], pageInfo: { count: 0, totalCount: 0 } }] } });
  }
}

class TestableBrowserSource extends OnesBrowserSource {
  async triggerAutoLogin(profile: OnesConfig["profiles"][string], page: object): Promise<void> {
    await this.autoLogin(profile, page as never);
  }
}

class AttachmentUrlSource extends OnesGraphqlSource {
  constructor(config: OnesConfig, private readonly resolvedUrl: string) {
    super(config);
  }

  async resolve(profile: OnesConfig["profiles"][string]): Promise<URL> {
    return this.resolveAttachmentUrl(profile, "attachment-1");
  }

  protected override async requestJson(): Promise<unknown> {
    return { url: this.resolvedUrl };
  }
}

class ConnectTestBrowserSource extends OnesBrowserSource {
  readonly authorizationWaits: number[] = [];
  private authorizationCall = 0;

  constructor(
    config: OnesConfig,
    private readonly authorizations: Array<{ authorized: boolean; diagnostics: string[] }>,
  ) {
    super(config);
  }

  protected override async ensurePage(): Promise<Page> {
    return {
      url: () => "https://tenant.example.test/project/#/workspace",
      waitForTimeout: async (delay: number) => { this.authorizationWaits.push(delay); },
    } as unknown as Page;
  }

  override async status() {
    const authorization = this.authorizations[Math.min(this.authorizationCall, this.authorizations.length - 1)]!;
    this.authorizationCall += 1;
    return { configured: true, credentialAvailable: true, ...authorization };
  }
}

function mockLoginPage(calls: string[], failOnEmailWait = false, redirectedUrl?: string, accountFieldStyle: "standard" | "account" = "standard"): object {
  let currentUrl = "https://tenant.example.test/initial";
  const emailField = {
    async waitFor() {
      calls.push("wait:email");
      if (failOnEmailWait) throw new Error("email field unavailable");
    },
    async fill(value: string) { calls.push(`fill:email:${value}`); },
  };
  const passwordField = {
    async waitFor() { calls.push("wait:password"); },
    async fill(value: string) { calls.push(`fill:password:${value}`); },
  };
  const submitButton = { async click() { calls.push("click:submit"); } };
  return {
    async goto(url: string) {
      calls.push(`goto:${url}`);
      currentUrl = redirectedUrl ?? url;
    },
    url() { return currentUrl; },
    locator(selector: string) {
      const field = accountFieldStyle === "account"
        ? selector.includes("name='account'")
          ? emailField
          : selector.includes("name='passwd'")
            ? passwordField
            : submitButton
        : selector.includes("type='email'")
          ? emailField
          : selector.includes("type='password'")
            ? passwordField
            : submitButton;
      return { first: () => field };
    },
  };
}

function response(value: unknown, status = 200): HttpResponse {
  return { status, headers: new Headers({ "content-type": "application/json" }), text: JSON.stringify(value) };
}

try {
  assert.throws(() => parseConfig({ ...config, token: "must-not-be-configured" }), { name: "TicketError" });
  assert.equal(
    (await new AttachmentUrlSource(config, "/api/project/file/attachment/abc?opaque=1").resolve(config.profiles.demo!)).toString(),
    "https://tenant.example.test/api/project/file/attachment/abc?opaque=1",
  );
  let outsideHostError = "";
  try {
    await new AttachmentUrlSource(config, "https://outside.example.test/file").resolve(config.profiles.demo!);
    assert.fail("an attachment URL outside the host allowlist must be rejected");
  } catch (error) {
    outsideHostError = String(error);
  }
  assert.match(outsideHostError, /outside the profile allowlist/);
  const missingCredentialConfig = JSON.parse(JSON.stringify(config)) as { profiles: Record<string, Record<string, unknown>> };
  delete missingCredentialConfig.profiles.demo!.secretRef;
  assert.throws(() => parseConfig(missingCredentialConfig), { name: "TicketError" });
  const browserProfileConfig = JSON.parse(JSON.stringify(config)) as { profiles: Record<string, Record<string, unknown>> };
  browserProfileConfig.profiles.demo!.source = "browser";
  delete browserProfileConfig.profiles.demo!.secretRef;
  browserProfileConfig.profiles.demo!.browser = {};
  assert.equal(parseConfig(browserProfileConfig).profiles.demo!.source, "browser");
  const legacyTreeConfig = JSON.parse(JSON.stringify(browserProfileConfig)) as { profiles: Record<string, Record<string, unknown>> };
  legacyTreeConfig.profiles.demo!.defaultView = "my_open_tree";
  assert.throws(() => parseConfig(legacyTreeConfig), { name: "TicketError" }, "the removed tree-view configuration must not be accepted as a compatibility path");
  const autoLoginProfileConfig = JSON.parse(JSON.stringify(browserProfileConfig)) as { profiles: Record<string, Record<string, unknown>> };
  autoLoginProfileConfig.profiles.demo!.browser = {
    autoLogin: { email: "operator@example.test", password: "test-only-password", loginUrl: "https://tenant.example.test/login" },
  };
  const autoLoginConfig = parseConfig(autoLoginProfileConfig);
  assert.equal(autoLoginConfig.profiles.demo!.browser?.autoLogin?.email, "operator@example.test");
  const missingLoginUrlConfig = JSON.parse(JSON.stringify(browserProfileConfig)) as { profiles: Record<string, Record<string, unknown>> };
  missingLoginUrlConfig.profiles.demo!.browser = { autoLogin: { email: "operator@example.test", password: "test-only-password" } };
  const parsedDefaultLoginConfig = parseConfig(missingLoginUrlConfig);
  const defaultLoginCalls: string[] = [];
  await new TestableBrowserSource(parsedDefaultLoginConfig).triggerAutoLogin(parsedDefaultLoginConfig.profiles.demo!, mockLoginPage(defaultLoginCalls));
  assert.equal(defaultLoginCalls[0], "goto:https://tenant.example.test/login");
  const graphQlAutoLoginConfig = JSON.parse(JSON.stringify(autoLoginProfileConfig)) as { profiles: Record<string, Record<string, unknown>> };
  graphQlAutoLoginConfig.profiles.demo!.source = "graphql";
  graphQlAutoLoginConfig.profiles.demo!.secretRef = "ONES_TEST_TOKEN";
  assert.throws(() => parseConfig(graphQlAutoLoginConfig), { name: "TicketError", message: /profiles\.demo\.browser\.autoLogin/ });
  const malformedAutoLoginConfig = JSON.parse(JSON.stringify(autoLoginProfileConfig)) as { profiles: Record<string, Record<string, { autoLogin: Record<string, unknown> }>> };
  malformedAutoLoginConfig.profiles.demo!.browser.autoLogin.email = "not-an-email";
  assert.throws(() => parseConfig(malformedAutoLoginConfig), { name: "TicketError" });
  const externalLoginConfig = JSON.parse(JSON.stringify(autoLoginProfileConfig)) as { profiles: Record<string, Record<string, { autoLogin: Record<string, unknown> }>> };
  externalLoginConfig.profiles.demo!.browser.autoLogin.loginUrl = "https://outside.example.test/login";
  assert.throws(() => parseConfig(externalLoginConfig), { name: "TicketError", message: /browser\.autoLogin\.loginUrl host is not in allowedHosts/ });
  const manualLoginCalls: string[] = [];
  await new TestableBrowserSource(parseConfig(browserProfileConfig)).triggerAutoLogin(parseConfig(browserProfileConfig).profiles.demo!, mockLoginPage(manualLoginCalls));
  assert.deepEqual(manualLoginCalls, []);
  const autoLoginCalls: string[] = [];
  await new TestableBrowserSource(autoLoginConfig).triggerAutoLogin(autoLoginConfig.profiles.demo!, mockLoginPage(autoLoginCalls));
  assert.deepEqual(autoLoginCalls, [
    "goto:https://tenant.example.test/login",
    "wait:email",
    "wait:password",
    "fill:email:operator@example.test",
    "fill:password:test-only-password",
    "click:submit",
  ]);
  const accountLoginCalls: string[] = [];
  await new TestableBrowserSource(autoLoginConfig).triggerAutoLogin(autoLoginConfig.profiles.demo!, mockLoginPage(accountLoginCalls, false, undefined, "account"));
  assert.deepEqual(accountLoginCalls.slice(1), [
    "wait:email",
    "wait:password",
    "fill:email:operator@example.test",
    "fill:password:test-only-password",
    "click:submit",
  ]);
  const confirmedConnect = await new ConnectTestBrowserSource(autoLoginConfig, [{ authorized: true, diagnostics: ["accepted"] }]).openBrowserSession(ticketProfile(autoLoginConfig));
  assert.equal(confirmedConnect.authentication.mode, "auto");
  assert.equal(confirmedConnect.authentication.authorized, true);
  assert.match(confirmedConnect.message, /confirmed by ONES/);
  const delayedConnectSource = new ConnectTestBrowserSource(autoLoginConfig, [
    { authorized: false, diagnostics: ["session is settling"] },
    { authorized: false, diagnostics: ["session is settling"] },
    { authorized: true, diagnostics: ["accepted"] },
  ]);
  const delayedConnect = await delayedConnectSource.openBrowserSession(ticketProfile(autoLoginConfig));
  assert.equal(delayedConnect.authentication.authorized, true);
  assert.deepEqual(delayedConnectSource.authorizationWaits, [500, 1_000, 2_000]);
  const unconfirmedConnect = await new ConnectTestBrowserSource(autoLoginConfig, [{ authorized: false, diagnostics: ["sign in"] }]).openBrowserSession(ticketProfile(autoLoginConfig));
  assert.equal(unconfirmedConnect.authentication.authorized, false);
  assert.match(unconfirmedConnect.message, /not yet confirmed/);
  await assert.rejects(
    () => new TestableBrowserSource(autoLoginConfig).triggerAutoLogin(autoLoginConfig.profiles.demo!, mockLoginPage([], true)),
    (error: unknown) => error instanceof Error
      && error.name === "TicketError"
      && !error.message.includes("operator@example.test")
      && !error.message.includes("test-only-password"),
  );
  await assert.rejects(
    () => new TestableBrowserSource(autoLoginConfig).triggerAutoLogin(autoLoginConfig.profiles.demo!, mockLoginPage([], false, "https://outside.example.test/login")),
    (error: unknown) => error instanceof Error
      && error.name === "TicketError"
      && !error.message.includes("operator@example.test")
      && !error.message.includes("test-only-password"),
  );
  const legacyProfileConfig = JSON.parse(JSON.stringify(config)) as { profiles: Record<string, Record<string, unknown>> };
  delete legacyProfileConfig.profiles.demo!.provider;
  assert.equal(parseConfig(legacyProfileConfig).profiles.demo!.provider, "ones");
  const application = createApplication(config, new FakeProvider(), new LocalTicketBundleStore(root));
  assert.equal((await application.connectionStatus("demo")).provider, "ones");
  const ticket = await application.getTicket("demo", { id: "task-1" });
  assert.equal(ticket.classification.value, "technical-change");
  assert.equal(ticket.source.ticketNumber, "#209161");
  assert.equal(ticket.severity, "提示");
  assert.equal(ticket.descriptionMarkdown, "安全描述a.png (https://tenant.example.test/api/project/file/attachment/abc)[image: 描述图]\n[image: 重复描述图]");
  assert.equal(ticket.descriptionImages?.[0]?.attachmentId, "attachment-1");
  assert.equal(ticket.descriptionImages?.[0]?.hash, "abc");
  assert.equal(ticket.descriptionImages?.[1]?.attachmentId, "attachment-1");
  assert.equal(ticket.comments[0]?.kind, "comment");
  assert.equal(ticket.comments[0]?.bodyMarkdown, "已处理 实施说明 (https://docs.example.test/guide)[image: 进度图]");
  assert.equal(ticket.comments[1]?.kind, "comment");
  assert.equal(ticket.comments[1]?.bodyMarkdown, "真实评论正文[image: 评论附件]");
  assert.equal(ticket.comments[1]?.createdAt, "2026-01-02");
  assert.equal(ticket.comments[1]?.author?.displayName, "开发者");
  assert.equal(ticket.comments[1]?.images?.[0]?.attachmentId, "attachment-1");
  assert.equal(ticket.comments[2]?.bodyMarkdown, "[image: 评论上传.png]");
  assert.equal(ticket.comments[2]?.images?.[0]?.attachmentId, "attachment-1");
  assert.equal(ticket.comments.length, 3);
  assert.equal(ticket.attachments.length, 1);
  assert.equal(ticket.source.ticketKey, "P-1");
  assert.equal(ticket.iteration?.name, "迭代 A");
  assert.equal(ticket.relations.length, 3);
  assert.equal(ticket.customFields.some((field) => field.id === "email"), false);
  assert.equal("sourceUrl" in ticket.attachments[0]!, false);
  const inlineTicket = projectTicketForInline(
    { ...ticket, descriptionMarkdown: "描述".repeat(20), comments: [...ticket.comments, { ...ticket.comments[0]!, id: "message-2", bodyMarkdown: "评论".repeat(20) }] },
    20,
  );
  assert.equal(inlineTicket.inline.truncated, true);
  assert.ok(inlineTicket.inline.contentChars <= 20);

  assert.throws(
    () => parseJsonResponse({ status: 302, headers: new Headers({ location: "https://outside.example.test" }), text: "" }),
    { name: "TicketError", message: /302/ },
  );
  assert.throws(
    () => parseJsonResponse({ status: 200, headers: new Headers({ "content-type": "text/html" }), text: "<html>not json</html>" }),
    { name: "TicketError", message: /not JSON/ },
  );
  assert.throws(
    () => parseJsonResponse({ status: 200, headers: new Headers({ "content-type": "text/html" }), text: "captcha required" }),
    { name: "TicketError", message: /human authentication/ },
  );
  const privateApplication = createApplication(
    { ...config, storage: { ...config.storage, redaction: { omitPeople: true, removeFields: ["email"] } } },
    new FakeProvider(),
    new LocalTicketBundleStore(root),
  );
  const privateTicket = await privateApplication.getTicket("demo", { id: "task-1" });
  assert.equal(privateTicket.assignee, undefined);
  assert.equal(privateTicket.comments[0]?.author, undefined);
  const privateSummary = await privateApplication.searchTickets({ profile: "demo", preset: "my_open" });
  assert.equal(privateSummary.items[0]?.assignee, undefined, "search summaries must honor omitPeople redaction");
  const outOfScopeProvider: TicketProvider = {
    providerId: "ones",
    async status() { return { configured: true, authorized: true, diagnostics: [] }; },
    async search() {
      return {
        items: [{ id: "outside-project-task", title: "Out of scope", projectId: "project-outside" }],
        page: { returned: 1, totalCount: 1, hasNextPage: false },
      };
    },
    async getTicket(profile) { return normalizeOnesTicket(config.profiles[profile.name]!, rawTicket); },
  };
  const outOfScopeApplication = createApplication(config, outOfScopeProvider, new LocalTicketBundleStore(root));
  await assert.rejects(
    () => outOfScopeApplication.searchTickets({ profile: "demo", preset: "all" }),
    { name: "TicketError", message: /outside the profile project allowlist/ },
    "application search must retain the final project allowlist defense",
  );
  await assert.rejects(
    () => outOfScopeApplication.exportTicketSearch("demo", { preset: "all" }, "plan", "metadata"),
    { name: "TicketError", message: /outside the profile project allowlist/ },
    "query export must retain the same final project allowlist defense while enumerating pages",
  );
  let rejectSecondDetail = false;
  let queryWriteSessions = 0;
  const detailFailureProvider: TicketProvider = {
    providerId: "ones",
    async status() { return { configured: true, authorized: true, diagnostics: [] }; },
    async search() {
      return {
        items: [
          { id: "query-task-1", title: "First", projectId: "project-demo" },
          { id: "query-task-2", title: "Second", projectId: "project-demo" },
        ],
        page: { returned: 2, totalCount: 2, hasNextPage: false },
      };
    },
    async getTicket(profile, reference) {
      if (rejectSecondDetail && reference.id === "query-task-2") throw new Error("second query detail failed");
      const normalized = normalizeOnesTicket(config.profiles[profile.name]!, rawTicket);
      return { ...normalized, source: { ...normalized.source, ticketId: reference.id } };
    },
  };
  const queryBundleStore: TicketBundleStore = {
    async plan(ticket) { return { directory: `D:/query-plans/${ticket.source.ticketId}`, files: [], contentHash: ticket.source.ticketId, action: "created" }; },
    async beginExport(ticket) {
      queryWriteSessions += 1;
      return {
        missingMedia: [],
        async writeMedia() {},
        async commit() { return { directory: `D:/query-plans/${ticket.source.ticketId}`, files: [], contentHash: ticket.source.ticketId, action: "created" as const, exportId: ticket.source.ticketId, status: "created" as const }; },
        async abort() {},
      };
    },
  };
  const detailFailureApplication = createApplication(config, detailFailureProvider, queryBundleStore);
  const frozenQueryPlan = await detailFailureApplication.exportTicketSearch("demo", { preset: "all" }, "plan", "metadata");
  assert.equal(frozenQueryPlan.selectedCount, 2);
  rejectSecondDetail = true;
  await assert.rejects(
    () => detailFailureApplication.exportTicketSearch("demo", { preset: "all" }, "write", "metadata", frozenQueryPlan.selection),
    /second query detail failed/,
    "a failed detail read must reject query write before any bundle write begins",
  );
  assert.equal(queryWriteSessions, 0, "query writes must not begin until every selected detail has been read successfully");

  const plan = await application.exportTicket("demo", { id: "task-1" }, "plan", "metadata");
  assert.equal(plan.action, "created");
  assert.deepEqual(plan.files.map((file) => file.path), [
    "ticket.md",
    "attachments/README.md",
    "assets/description/README.md",
    "assets/comments/README.md",
    "_machine/ticket.json",
    "_machine/comments.json",
    "_machine/relations.json",
    "_machine/attachments.json",
    "_machine/media.json",
    "_machine/manifest.json",
  ]);
  const firstWrite = await application.exportTicket("demo", { id: "task-1" }, "write", "metadata");
  assert.ok("status" in firstWrite);
  assert.equal(firstWrite.status, "created");
  assert.match(firstWrite.directory.replace(/\\/g, "/"), /\/ones\/project-demo\/#209161$/);
  const manifest = JSON.parse(await readFile(join(firstWrite.directory, "_machine", "manifest.json"), "utf8")) as { layoutVersion: number; attachmentCount: number; files: Array<{ path: string; sha256: string }> };
  assert.equal(manifest.layoutVersion, 3);
  assert.equal(manifest.attachmentCount, 1);
  assert.equal(manifest.files.length, 9);
  assert.ok(manifest.files.every((file) => file.sha256.length === 64));
  assert.ok(firstWrite.files.every((file) => file.sha256.length === 64));
  (rawTicket.detail as { name: string }).name = "已更新的技术改造";
  const updateWrite = await application.exportTicket("demo", { id: "task-1" }, "write", "metadata");
  assert.ok("status" in updateWrite);
  assert.equal(updateWrite.status, "updated");
  const ticketMarkdown = await readFile(join(updateWrite.directory, "ticket.md"), "utf8");
  assert.match(ticketMarkdown, /已更新的技术改造/);
  assert.doesNotMatch(ticketMarkdown, /\[a\.png\]\(attachments\/README\.md#attachment-1\)/);
  assert.match(ticketMarkdown, /\[描述图\]\(assets\/description\/README\.md#description-image-1\)/);
  assert.match(ticketMarkdown, /\[重复描述图\]\(assets\/description\/README\.md#description-image-2\)/);
  assert.match(ticketMarkdown, /\[进度图\]\(assets\/comments\/README\.md#comment-image-1-1\)/);
  assert.match(ticketMarkdown, /## 评论/);
  assert.match(ticketMarkdown, /严重程度：提示/);
  assert.doesNotMatch(ticketMarkdown, /## 动态/);
  assert.doesNotMatch(ticketMarkdown, /update: 状态/);
  assert.doesNotMatch(ticketMarkdown, /### 内联图片/);
  const attachmentsIndex = await readFile(join(updateWrite.directory, "attachments", "README.md"), "utf8");
  assert.doesNotMatch(attachmentsIndex, /## attachment-1/);
  const descriptionImagesIndex = await readFile(join(updateWrite.directory, "assets", "description", "README.md"), "utf8");
  assert.match(descriptionImagesIndex, /## description-image-1/);
  assert.match(descriptionImagesIndex, /## description-image-2/);
  assert.match(descriptionImagesIndex, /描述图/);
  assert.match(descriptionImagesIndex, /未下载描述图片/);
  const commentImagesIndex = await readFile(join(updateWrite.directory, "assets", "comments", "README.md"), "utf8");
  assert.match(commentImagesIndex, /## comment-image-1-1/);
  assert.match(commentImagesIndex, /进度图/);
  const mediaRoot = join(root, "media-download");
  let mediaDownloadCount = 0;
  const mediaApplication = new TicketApplication({
    profiles: new StaticTicketProfileResolver([{ name: "demo", providerId: "ones", connector: "graphql", allowedProjects: ["project-demo"], inlineMaxChars: 12_000 }]),
    provider: new FakeProvider(),
    bundleStore: new LocalTicketBundleStore(mediaRoot),
    redaction: config.storage.redaction,
    mediaProvider: { async downloadAttachment(_profile, attachment) { mediaDownloadCount += 1; return { attachment, bytes: new TextEncoder().encode("image-bytes"), contentType: "image/png" }; } },
  });
  const mediaPlan = await mediaApplication.exportTicket("demo", { id: "task-1" }, "plan");
  assert.ok(mediaPlan.files.some((file) => file.path === "assets/description/attachment-1-a.png"));
  const mediaWrite = await mediaApplication.exportTicket("demo", { id: "task-1" }, "write");
  assert.ok("status" in mediaWrite);
  assert.equal(mediaDownloadCount, 1);
  assert.equal((await readFile(join(mediaWrite.directory, "assets", "description", "attachment-1-a.png"), "utf8")), "image-bytes");
  const mediaMarkdown = await readFile(join(mediaWrite.directory, "ticket.md"), "utf8");
  assert.match(mediaMarkdown, /\[a\.png\]\(assets\/description\/attachment-1-a\.png\)/);
  assert.match(mediaMarkdown, /!\[描述图\]\(assets\/description\/attachment-1-a\.png\)/);
  assert.match(mediaMarkdown, /!\[重复描述图\]\(assets\/description\/attachment-1-a\.png\)/);
  assert.doesNotMatch(mediaMarkdown, /\[image:/);
  assert.doesNotMatch(mediaMarkdown, /### 内联图片/);
  assert.doesNotMatch(mediaMarkdown, /tenant\.example\.test\/api\/project\/file\/attachment\/abc/);
  const downloadedDescriptionImagesIndex = await readFile(join(mediaWrite.directory, "assets", "description", "README.md"), "utf8");
  assert.match(downloadedDescriptionImagesIndex, /已下载 1 张描述图片/);
  assert.doesNotMatch(downloadedDescriptionImagesIndex, /当前版本不下载/);
  const mediaManifest = JSON.parse(await readFile(join(mediaWrite.directory, "_machine", "media.json"), "utf8")) as Array<{ roles: string[] }>;
  assert.deepEqual(mediaManifest[0]?.roles.sort(), ["attachment", "comment-image", "description-image"]);
  const resumedMediaWrite = await mediaApplication.exportTicket("demo", { id: "task-1" }, "write");
  assert.ok("status" in resumedMediaWrite);
  assert.equal(resumedMediaWrite.status, "unchanged");
  assert.equal(mediaDownloadCount, 1);
  await writeFile(join(mediaWrite.directory, "assets", "description", "attachment-1-a.png"), "corrupted", "utf8");
  const repairedMediaWrite = await mediaApplication.exportTicket("demo", { id: "task-1" }, "write");
  assert.ok("status" in repairedMediaWrite);
  assert.equal(repairedMediaWrite.status, "updated");
  assert.equal(mediaDownloadCount, 2);
  assert.equal((await readFile(join(mediaWrite.directory, "assets", "description", "attachment-1-a.png"), "utf8")), "image-bytes");
  const stagedReuseStore = new LocalTicketBundleStore(join(root, "staged-media-reuse"));
  const stagedMedia = [{ attachment: ticket.attachments[0]!, roles: ["attachment", "description-image"] as Array<"attachment" | "description-image">, path: "assets/description/attachment-1-a.png" }];
  const stagedInitialSession = await stagedReuseStore.beginExport(ticket, stagedMedia);
  await stagedInitialSession.writeMedia(stagedInitialSession.missingMedia[0]!, { attachment: ticket.attachments[0]!, bytes: new TextEncoder().encode("image-bytes") });
  const stagedInitial = await stagedInitialSession.commit();
  const stagedSession = await stagedReuseStore.beginExport({ ...ticket, title: "updated after staging" }, stagedMedia);
  assert.deepEqual(stagedSession.missingMedia, []);
  await rm(join(stagedInitial.directory, "assets", "description", "attachment-1-a.png"));
  const stagedReuse = await stagedSession.commit();
  assert.equal(stagedReuse.status, "updated");
  assert.equal(await readFile(join(stagedReuse.directory, "assets", "description", "attachment-1-a.png"), "utf8"), "image-bytes");
  const beforeFailedResume = await readFile(join(mediaWrite.directory, "ticket.md"), "utf8");
  await writeFile(join(mediaWrite.directory, "assets", "description", "attachment-1-a.png"), "corrupted-again", "utf8");
  const failingMediaApplication = new TicketApplication({
    profiles: new StaticTicketProfileResolver([{ name: "demo", providerId: "ones", connector: "graphql", allowedProjects: ["project-demo"], inlineMaxChars: 12_000 }]),
    provider: new FakeProvider(),
    bundleStore: new LocalTicketBundleStore(mediaRoot),
    redaction: config.storage.redaction,
    mediaProvider: { async downloadAttachment() { throw new Error("download interrupted"); } },
  });
  await assert.rejects(() => failingMediaApplication.exportTicket("demo", { id: "task-1" }, "write"), /download interrupted/);
  assert.equal(await readFile(join(mediaWrite.directory, "ticket.md"), "utf8"), beforeFailedResume);
  assert.deepEqual(await readdir(join(mediaRoot, "ones", "project-demo")), ["#209161"]);
  const guardedStore = new LocalTicketBundleStore(join(root, "session-guard"));
  const guardedSession = await guardedStore.beginExport(ticket);
  await assert.rejects(() => guardedStore.beginExport(ticket), /already in progress/);
  await guardedSession.abort();
  let activeMediaDownloads = 0;
  let maxActiveMediaDownloads = 0;
  const mediaOrder: string[] = [];
  const sequentialTicket = { ...ticket, attachments: [...ticket.attachments, { ...ticket.attachments[0]!, id: "attachment-2", name: "b.png", hash: "def" }] };
  const sequentialProvider: TicketProvider = {
    providerId: "ones",
    async status() { return { configured: true, authorized: true, diagnostics: [] }; },
    async search() { return { items: [{ id: "task-1", title: "示例技术改造", projectId: "project-demo" }], page: { returned: 1, totalCount: 1, hasNextPage: false } }; },
    async getTicket() { return sequentialTicket; },
  };
  const sequentialApplication = new TicketApplication({
    profiles: new StaticTicketProfileResolver([{ name: "demo", providerId: "ones", connector: "graphql", allowedProjects: ["project-demo"], inlineMaxChars: 12_000 }]),
    provider: sequentialProvider,
    bundleStore: new LocalTicketBundleStore(join(root, "sequential-media-download")),
    redaction: config.storage.redaction,
    mediaProvider: {
      async downloadAttachment(_profile, attachment) {
        activeMediaDownloads += 1;
        maxActiveMediaDownloads = Math.max(maxActiveMediaDownloads, activeMediaDownloads);
        mediaOrder.push(attachment.id);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        activeMediaDownloads -= 1;
        return { attachment, bytes: new TextEncoder().encode(attachment.id), contentType: "image/png" };
      },
    },
  });
  await sequentialApplication.exportTicket("demo", { id: "task-1" }, "write");
  assert.equal(maxActiveMediaDownloads, 1);
  assert.deepEqual(mediaOrder, ["attachment-1", "attachment-2"]);
  const hashOnlyRoot = join(root, "hash-only-image");
  const hashOnlyStore = new LocalTicketBundleStore(hashOnlyRoot);
  const hashOnlyTicket = { ...ticket, descriptionImages: [{ hash: "abc", alt: "hash only" }] };
  const hashOnlySession = await hashOnlyStore.beginExport(hashOnlyTicket, [{ attachment: ticket.attachments[0]!, roles: ["attachment", "description-image"], path: "assets/description/attachment-1-a.png" }]);
  await hashOnlySession.writeMedia(hashOnlySession.missingMedia[0]!, { attachment: ticket.attachments[0]!, bytes: new TextEncoder().encode("image-bytes") });
  const hashOnlyWrite = await hashOnlySession.commit();
  const hashOnlyMarkdown = await readFile(join(hashOnlyWrite.directory, "ticket.md"), "utf8");
  assert.match(hashOnlyMarkdown, /!\[hash only\]\(assets\/description\/attachment-1-a\.png\)/);
  assert.doesNotMatch(hashOnlyMarkdown, /\[a\.png\]\(attachments\/README\.md#attachment-1\)/);
  const latestManifest = JSON.parse(await readFile(join(updateWrite.directory, "_machine", "manifest.json"), "utf8")) as { contentHash: string };
  await writeFile(join(updateWrite.directory, "manifest.json"), JSON.stringify({ contentHash: latestManifest.contentHash }), "utf8");
  await rm(join(updateWrite.directory, "_machine", "manifest.json"));
  const migratedWrite = await application.exportTicket("demo", { id: "task-1" }, "write", "metadata");
  assert.ok("status" in migratedWrite);
  assert.equal(migratedWrite.status, "updated");
  const secondWrite = await application.exportTicket("demo", { id: "task-1" }, "write", "metadata");
  assert.ok("status" in secondWrite);
  assert.equal(secondWrite.status, "unchanged");

  const ticketWithoutId = normalizeOnesTicket(config.profiles.demo!, {
    ...rawTicket,
    detail: { ...(rawTicket.detail as Record<string, unknown>), importantField: [] },
  });
  const fallbackPlan = await new LocalTicketBundleStore(root).plan(ticketWithoutId);
  assert.match(fallbackPlan.directory.replace(/\\/g, "/"), /\/ones\/project-demo\/task-1$/);

  const http = new RecordingHttpClient();
  const graphql = new OnesGraphqlSource(config, new StaticSecretProvider(), http);
  const graphSearchQuery: TicketSearchQuery = {
    preset: "my_open",
    filter: { all: [{ field: "statusCategory", op: "notIn", values: ["done"] }, { field: "assignee", op: "in", values: ["me"] }] },
    sort: { field: "createTime", direction: "desc" },
    page: { size: 50 },
  };
  const fixtureDirectory = join(process.cwd(), ".cloudpivot-cli", "task-runs", "ticket-tool-surface-design");
  const readFixture = async (file: string) => JSON.parse(await readFile(join(fixtureDirectory, file), "utf8")) as { query: string; variables: Record<string, unknown> };
  const profileWithoutProjectConstraint = { ...config.profiles.demo!, allowedProjects: [] };
  const myOpenFixture = await readFixture("ones-items-graphql-my-open-status-category-not-in-done-assignee-me.request.json");
  assert.match(myOpenFixture.query, /pageInfo[\s\S]*hasNextPage/, "the archived real request must retain the observed pageInfo fields");
  assert.deepEqual(
    compileOnesTicketSearchVariables(profileWithoutProjectConstraint, graphSearchQuery),
    myOpenFixture.variables,
    "my_open compilation must match the archived real ONES request variables when no profile project constraint is added",
  );
  const lazyLoadFixture = await readFixture("ones-items-graphql-lazy-load-after-status-not-in-assignee-not-in-me.request.json");
  const lazyPagination = lazyLoadFixture.variables.pagination as { limit: number; after: string; preciseCount?: unknown };
  assert.equal(lazyPagination.limit, 50);
  assert.equal(typeof lazyPagination.after, "string");
  assert.equal("preciseCount" in lazyPagination, false, "the archived continuation request omits preciseCount");
  assert.deepEqual(
    compileOnesTicketSearchVariables(profileWithoutProjectConstraint, { ...graphSearchQuery, page: { size: 50, after: lazyPagination.after } }).pagination,
    lazyPagination,
    "a continuation must compile the archived after shape without reintroducing preciseCount",
  );
  const projectFixture = await readFixture("ones-items-graphql-project-field-in-assignee-in-redacted.request.json");
  const projectFixtureFilter = (projectFixture.variables.filterGroup as Array<Record<string, unknown>>)[0];
  assert.ok(projectFixtureFilter && "_CFcrFX1y_in" in projectFixtureFilter, "the archived project filter stays evidence for a deferred capability, not a public V1 filter");
  const firstProviderSearch = await graphql.search(ticketProfile(config), graphSearchQuery);
  assert.equal(firstProviderSearch.page.returned, 1);
  assert.equal(firstProviderSearch.page.totalCount, 2);
  assert.equal(firstProviderSearch.page.hasNextPage, true);
  assert.equal(firstProviderSearch.page.endCursor, "cursor-1");
  const secondProviderSearch = await graphql.search(ticketProfile(config), { ...graphSearchQuery, page: { size: 50, after: firstProviderSearch.page.endCursor } });
  assert.equal(secondProviderSearch.page.returned, 1);
  assert.equal(secondProviderSearch.page.hasNextPage, false);
  assert.equal(JSON.parse(http.requests[1]!.body!).variables.pagination.after, "cursor-1", "ONES endCursor must become the next request after");
  assert.ok(!http.requests[0]?.body?.includes("includeAncestors"));
  const providerTicket = await graphql.getTicket(ticketProfile(config), { id: "uuid-1" });
  assert.equal(providerTicket.source.provider, "ones");
  assert.equal(providerTicket.source.ticketId, "task-1");
  assert.equal(http.requests.length, 5);
  assert.ok(http.requests[0]?.body?.includes("assign_in"));
  assert.equal(http.requests[0]?.headers.Authorization, "Bearer test-token");
  assert.ok(http.requests.some((request) => request.url.pathname.endsWith("/messages")));
  assert.ok(!http.requests.some((request) => request.url.pathname.includes("/attachments")));
  const detailRequest = http.requests.find((request) => request.body?.includes("TaskDetail"));
  const attachmentRequest = http.requests.find((request) => request.body?.includes("TaskAttachments"));
  assert.equal(JSON.parse(detailRequest!.body!).variables.key, "task-uuid-1");
  assert.equal(JSON.parse(attachmentRequest!.body!).variables.key, "task-uuid-1");
  assert.ok(!http.requests.some((request) => request.url.search.includes("since=0")));

  const missingPageInfoSource = new OnesGraphqlSource(config, new StaticSecretProvider(), new MissingHasNextPageHttpClient());
  await assert.rejects(
    () => missingPageInfoSource.search(ticketProfile(config), graphSearchQuery),
    { name: "TicketError", message: /continuation flag/ },
    "missing pageInfo.hasNextPage must fail closed instead of truncating results",
  );

  const searchQuery: TicketSearchQuery = {
    preset: "my_active",
    filter: {
      all: [
        { field: "title", op: "contains", value: "111" },
        { field: "issueType", op: "in", values: ["WjULPrZa"] },
        { field: "statusCategory", op: "in", values: ["to_do", "in_progress"] },
        { field: "assignee", op: "in", values: ["me"] },
      ],
    },
    sort: { field: "createTime", direction: "desc" },
    page: { size: 50 },
  };
  const titleFixture = await readFixture("ones-items-graphql-title-match-issue-type-status-category-in-assignee-me.request.json");
  assert.deepEqual(
    compileOnesTicketSearchVariables(profileWithoutProjectConstraint, searchQuery),
    titleFixture.variables,
    "title, issue type, status category, and current-user compilation must match the archived real request variables",
  );
  assert.deepEqual(compileOnesTicketSearchVariables(config.profiles.demo!, searchQuery), {
    groupBy: { tasks: {} },
    groupOrderBy: null,
    orderBy: { createTime: "DESC" },
    filterGroup: [{
      name_match: "111",
      issueType_in: ["WjULPrZa"],
      statusCategory_in: ["to_do", "in_progress"],
      assign_in: ["$currentUser"],
      project_in: ["project-demo"],
    }],
    search: null,
    pagination: { limit: 50, preciseCount: false },
  }, "the ONES adapter must compile only the frozen flat v1 variables");
  assert.deepEqual(compileOnesTicketSearchVariables(config.profiles.demo!, { ...searchQuery, page: { size: 50, after: "internal-after" } }).pagination, { limit: 50, after: "internal-after" });
  const providerSearch = await graphql.search(ticketProfile(config), searchQuery);
  assert.equal(providerSearch.page.totalCount, 2, "flat search preserves the matching total rather than the current page count");
  assert.equal(providerSearch.page.returned, 1);
  const searchRequest = http.requests.at(-1);
  const searchVariables = JSON.parse(searchRequest!.body!).variables;
  assert.deepEqual(searchVariables.filterGroup[0], {
    name_match: "111",
    issueType_in: ["WjULPrZa"],
    statusCategory_in: ["to_do", "in_progress"],
    assign_in: ["$currentUser"],
    project_in: ["project-demo"],
  });
  assert.equal(searchVariables.pagination.preciseCount, false);
  assert.ok(!searchRequest!.body!.includes("includeAncestors"), "ticket_search must not request legacy tree context rows");

  const fallbackHttp = new RecordingHttpClient(true);
  const fallbackSource = new OnesGraphqlSource(config, new StaticSecretProvider(), fallbackHttp);
  await assert.rejects(() => fallbackSource.getTicket(ticketProfile(config), { id: "uuid-1" }), { name: "TicketError", message: /detailGraphql.*400/ });
  assert.equal(fallbackHttp.requests.length, 1);

  const partialHttp = new RecordingHttpClient(false, true);
  const partialSource = new OnesGraphqlSource(config, new StaticSecretProvider(), partialHttp);
  await assert.rejects(() => partialSource.getTicket(ticketProfile(config), { id: "uuid-1" }), { name: "TicketError", message: /messages.*400/ });

  assert.throws(
    () => parseConfig({
      ...config,
      profiles: { demo: { ...config.profiles.demo!, token: "json-token" } },
    }),
    { name: "TicketError" },
  );

  const constrainedConfig: OnesConfig = { ...config, profiles: { demo: { ...config.profiles.demo!, requestBudget: { maxConcurrent: 1, maxRequestsPerMinute: 2 } } } };
  const constrainedSource = new ControlledClockSource(constrainedConfig, new StaticSecretProvider(), new RecordingHttpClient());
  await constrainedSource.search(ticketProfile(constrainedConfig), graphSearchQuery);
  await constrainedSource.search(ticketProfile(constrainedConfig), graphSearchQuery);
  await constrainedSource.search(ticketProfile(constrainedConfig), graphSearchQuery);
  assert.equal(constrainedSource.waits.length, 1);
  assert.ok(constrainedSource.waits[0]! >= 60_000);

  const retryHttp = new RetryOnceHttpClient();
  const retrySource = new ControlledClockSource(config, new StaticSecretProvider(), retryHttp);
  await retrySource.search(ticketProfile(config), graphSearchQuery);
  assert.deepEqual(retrySource.waits, [2_000]);
  assert.equal(retryHttp.requests.length, 2);

  console.log("ONES MCP unit and integration tests passed.");
} finally {
  await removeTestDirectory(root);
}
