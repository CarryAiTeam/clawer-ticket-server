import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const skill = await readFile(new URL("../../.agents/skills/ones-ticket-mcp/SKILL.md", import.meta.url), "utf8");

assert.match(skill, /^---\r?\nname: ones-ticket-mcp\r?\ndescription: .+\r?\n---/m, "the project Skill must declare Codex metadata");

const ticketTools = [
  "mcp__clawer_ticket__ticket_browser_connect",
  "mcp__clawer_ticket__ticket_browser_disconnect",
  "mcp__clawer_ticket__ticket_connection_status",
  "mcp__clawer_ticket__ticket_search",
  "mcp__clawer_ticket__ticket_get",
  "mcp__clawer_ticket__ticket_export",
];

for (const tool of ticketTools) assert.ok(skill.includes(`\`${tool}\``), `Skill must route calls to ${tool}`);

for (const requiredRule of [
  "原始请求本身就是一次性授权",
  "规范化工单标识",
  "不要求用户回复“连接 ONES”",
  "SOURCE_UNAUTHORIZED",
  "HUMAN_ACTION_REQUIRED",
  "authentication.authorized: true",
  "重试原始只读调用一次",
  "纯数字工单号",
  "精确匹配",
  "内部 `id`",
  "获取 → 授权 → 读取 → 关闭",
  "finally",
  "不要求用户确认关闭",
  "ticket_browser_disconnect",
]) {
  assert.ok(skill.includes(requiredRule), `Skill must retain the automatic browser authorization rule: ${requiredRule}`);
}

assert.ok(!skill.includes("用户明确要求登录/连接浏览器"), "browser authorization must not require a second explicit user confirmation");

for (const requiredRule of [
  "scope",
  "state",
  "self",
  "project",
  "open",
  "active",
  "done",
  "all",
  "获取 ONES 工单",
  "获取所有 ONES",
  "获取所有人的工单",
  "allowedProjects",
  "issueType",
  "statusCategory",
  "assignee",
  "nextCursor",
  "page.cursor",
  "QUERY_CURSOR_INVALID",
  "SELECTION_CHANGED",
  "EXPORT_LIMIT_EXCEEDED",
  "mode: \"plan\"",
  "mode: \"write\"",
  "media: \"metadata\"",
  "media: \"download\"",
  "failedTickets",
  "裸“获取”不触发本地写入",
]) {
  assert.ok(skill.includes(requiredRule), `Skill must retain the ${requiredRule} safety rule`);
}

for (const [phrase, tool] of [
  ["查看、查阅、查询、列出、获取 ONES 工单", "ticket_search"],
  ["查看详情、查阅某工单详情、获取某工单详情", "ticket_get"],
  ["下载到本地、导出、保存到本地、获取到本地", "ticket_export"],
] as const) {
  const hasRoute = skill.split(/\r?\n/).some((candidate) => candidate.includes(phrase) && candidate.includes(tool));
  assert.ok(hasRoute, `${phrase} must route to ${tool}`);
}

for (const [phrase, expected] of [
  ["获取 ONES 工单", '{ "scope": "self", "state": "open" }'],
  ["获取我的待办", '{ "scope": "self", "state": "open" }'],
  ["获取所有 ONES", '{ "scope": "self", "state": "all" }'],
  ["获取所有人的工单", '{ "scope": "project", "state": "open" }'],
  ["获取所有人的所有工单", '{ "scope": "project", "state": "all" }'],
] as const) {
  const hasMapping = skill.split(/\r?\n/).some((candidate) => candidate.includes(phrase) && candidate.includes(expected));
  assert.ok(hasMapping, `${phrase} must map to ${expected}`);
}

console.log("ONES ticket MCP Skill contract validates.");
