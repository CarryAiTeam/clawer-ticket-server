import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

type Call = { tool: string; purpose?: string; outcome?: string; retryOf?: number; autoLogin?: boolean; mode?: "plan" | "write"; selection?: "prior-plan"; match?: { field: string; value: string; mode: string } };
type Scenario = {
  id: string;
  route: "list" | "detail" | "export" | "blocked";
  calls: Call[];
  policy: { auth: "ready" | "automatic" | "challenge" | "not-needed"; retryOnce?: boolean; cleanup: "disconnect" | "leave-open" | "if-session"; exportFlow?: "plan-only" | "direct-write" | "planned-write"; queryBlocked?: boolean; exactMatch?: boolean };
};

const skillRoot = new URL("../../skills/ones-ticket-mcp/", import.meta.url);
const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");
const metadata = await readFile(new URL("agents/openai.yaml", skillRoot), "utf8");
const fixture = JSON.parse(await readFile(new URL("fixtures/ones-ticket-mcp-scenarios.json", import.meta.url), "utf8")) as { version: number; scenarios: Scenario[] };
const tools = new Set(["ticket_browser_connect", "ticket_browser_disconnect", "ticket_connection_status", "ticket_search", "ticket_get", "ticket_export"]);
const find = (id: string) => {
  const value = fixture.scenarios.find((candidate) => candidate.id === id);
  assert.ok(value, `fixture must contain ${id}`);
  return value;
};
const indexOf = (calls: Call[], tool: string, from = 0) => {
  const index = calls.findIndex((call, position) => position >= from && call.tool === tool);
  assert.notEqual(index, -1, `scenario must call ${tool}`);
  return index;
};

// P0: compact router, deterministic lifecycle, and one-level references.
const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(frontmatter, "the project Skill must declare frontmatter");
assert.match(frontmatter[1]!, /^name:\s*ones-ticket-mcp$/m);
assert.match(frontmatter[1]!, /^description:\s*.+自动授权.+自动清理/m);
assert.ok(skill.split(/\r?\n/).length <= 90, "the main Skill should stay compact");
assert.ok(skill.length <= 8_000, "low-frequency contracts belong in references");
for (const heading of ["## 工具与路由", "## 固定执行顺序", "## 按需读取的参考契约"]) assert.ok(skill.includes(heading));
for (const tool of tools) assert.ok(skill.includes(`mcp__clawer_ticket__${tool}`), `main Skill must name ${tool}`);
for (const [request, tool] of [
  ["查看、查阅、查询、列出、获取工单", "ticket_search"],
  ["查看/获取某工单详情", "ticket_get"],
  ["下载到本地、导出、保存、获取到本地", "ticket_export"],
] as const) assert.match(skill, new RegExp("\\\\| " + request + " \\\\| `" + tool + "`"), `route table must map ${request}`);
for (const rule of [
  "normalize profile/ref → execute intended call → auth recovery once → retry once → disconnect in finally → render result",
  "不要求回复“连接 ONES”",
  "authentication.authorized: true",
  "无需二次确认",
  "明确“下载到本地、导出、保存到本地、获取到本地”本身也是一次写入授权",
  "不要求用户确认关闭",
  "MFA",
  "CAPTCHA",
  "SSO",
  "allowedProjects",
  "mode: \"plan\"",
  "mode: \"write\"",
]) assert.ok(skill.includes(rule), `main Skill must retain ${rule}`);

const references = ["references/intent-mapping.md", "references/query-contract.md", "references/export-safety.md", "references/errors.md"];
assert.deepEqual([...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map((match) => match[1]!), references);
for (const reference of references) {
  const content = await readFile(new URL(reference, skillRoot), "utf8");
  assert.ok(content.trim().length > 0, `${reference} must be usable`);
  assert.ok(!/\]\((?:\.\.\/|references\/)/.test(content), `${reference} must not require a nested reference hop`);
}
const exportSafety = await readFile(new URL("references/export-safety.md", skillRoot), "utf8");
for (const rule of ["计划、预览、先看看", "不要先展示计划再要求“确认下载”", "mode: \"write\""]) {
  assert.ok(exportSafety.includes(rule), `export safety must retain ${rule}`);
}
assert.match(metadata, /^interface:\r?\n/m);
assert.match(metadata, /display_name:\s*"[^"]+"/);
assert.match(metadata, /short_description:\s*"[^"]{25,64}"/);
assert.match(metadata, /default_prompt:\s*"[^"]*\$ones-ticket-mcp[^"]*"/);

// P1: machine-readable scenarios prove ordering and the necessary exceptions.
assert.equal(fixture.version, 2);
assert.equal(fixture.scenarios.length, 8, "fixture must cover all P0/P1 paths");
assert.equal(new Set(fixture.scenarios.map(({ id }) => id)).size, fixture.scenarios.length, "scenario IDs must be unique");
for (const current of fixture.scenarios) {
  assert.ok(current.calls.length > 0, `${current.id} must describe calls`);
  for (const { tool } of current.calls) assert.ok(tools.has(tool), `${current.id} uses an unknown tool`);
  if (current.policy.cleanup === "disconnect") assert.ok(current.calls.some(({ tool }) => tool === "ticket_browser_disconnect"), `${current.id} must clean up`);
  if (current.policy.cleanup === "leave-open") assert.ok(!current.calls.some(({ tool }) => tool === "ticket_browser_disconnect"), `${current.id} must leave the challenge page open`);
  if (current.policy.exportFlow) assert.equal(current.route, "export", "an export flow must use the export route");
}

{
  const current = find("ready-numeric-detail");
  const search = current.calls.find(({ purpose }) => purpose === "resolve-number");
  assert.deepEqual(search?.match, { field: "number", value: "209488", mode: "exact" });
  assert.ok(indexOf(current.calls, "ticket_search") < indexOf(current.calls, "ticket_get"));
  assert.ok(indexOf(current.calls, "ticket_get") < indexOf(current.calls, "ticket_browser_disconnect"));
}
{
  const current = find("missing-browser-auto-login");
  const first = indexOf(current.calls, "ticket_search");
  const status = indexOf(current.calls, "ticket_connection_status", first + 1);
  const connect = indexOf(current.calls, "ticket_browser_connect", status + 1);
  const retry = indexOf(current.calls, "ticket_search", connect + 1);
  assert.equal(current.calls[first]!.outcome, "SOURCE_UNAUTHORIZED");
  assert.equal(current.calls[connect]!.autoLogin, true);
  assert.equal(current.calls[retry]!.retryOf, first);
  assert.equal(current.policy.retryOnce, true);
  assert.ok(retry < indexOf(current.calls, "ticket_browser_disconnect"));
}
{
  const current = find("mfa-or-sso-challenge");
  assert.equal(current.policy.auth, "challenge");
  assert.equal(current.calls[indexOf(current.calls, "ticket_browser_connect")]!.outcome, "HUMAN_ACTION_REQUIRED");
}
{
  const current = find("numeric-not-found");
  assert.ok(current.calls.filter(({ tool }) => tool === "ticket_search").length >= 2, "not-found lookup must page through results");
  assert.equal(current.policy.exactMatch, false);
  assert.equal(current.calls.at(-1)!.tool, "ticket_browser_disconnect");
}
{
  const current = find("export-plan");
  assert.equal(current.calls[0]!.purpose, "plan");
  assert.equal(current.calls[0]!.mode, "plan");
  assert.equal(current.policy.exportFlow, "plan-only");
  assert.ok(!current.calls.some(({ purpose }) => purpose === "write"), "an explicit preview request must not write");
}
{
  const current = find("direct-export-write");
  const write = indexOf(current.calls, "ticket_export");
  assert.equal(current.calls[write]!.purpose, "write");
  assert.equal(current.calls[write]!.mode, "write");
  assert.equal(current.calls[write]!.selection, undefined);
  assert.equal(current.policy.exportFlow, "direct-write");
  assert.ok(!current.calls.some(({ purpose }) => purpose === "plan"), "a direct export must not wait for a preview or repeated confirmation");
}
{
  const current = find("planned-export-write");
  const write = indexOf(current.calls, "ticket_export");
  assert.equal(current.calls[write]!.purpose, "write");
  assert.equal(current.calls[write]!.mode, "write");
  assert.equal(current.calls[write]!.selection, "prior-plan");
  assert.equal(current.policy.exportFlow, "planned-write");
  assert.ok(!current.calls.some(({ purpose }) => purpose === "plan"), "writing an already previewed export must reuse rather than repeat its plan");
}
{
  const current = find("project-without-allowlist");
  assert.equal(current.calls[0]!.tool, "ticket_connection_status");
  assert.equal(current.calls[0]!.outcome, "SOURCE_NOT_ALLOWED");
  assert.equal(current.policy.queryBlocked, true);
  assert.ok(!current.calls.some(({ tool }) => tool === "ticket_search"), "project query must not run without allowedProjects");
}

console.log("ONES ticket MCP Skill structure and automation scenarios validate.");
