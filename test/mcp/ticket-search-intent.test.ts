import assert from "node:assert/strict";
import { normalizeTicketSearchInput } from "../../src/modules/tickets/domain/ticket-search.js";

const intentCases = [
  {
    name: "获取 ONES 工单",
    input: {},
    expected: {
      scope: "self",
      state: "open",
      filter: [
        { field: "statusCategory", op: "notIn", values: ["done"] },
        { field: "assignee", op: "in", values: ["me"] },
      ],
    },
  },
  {
    name: "获取所有 ONES",
    input: { scope: "self", state: "all" },
    expected: {
      scope: "self",
      state: "all",
      filter: [{ field: "assignee", op: "in", values: ["me"] }],
    },
  },
  {
    name: "获取所有人的工单",
    input: { scope: "project", state: "open" },
    expected: {
      scope: "project",
      state: "open",
      filter: [{ field: "statusCategory", op: "notIn", values: ["done"] }],
    },
  },
  {
    name: "获取所有人的所有工单",
    input: { scope: "project", state: "all" },
    expected: { scope: "project", state: "all", filter: [] },
  },
  {
    name: "获取我正在处理的工单",
    input: { scope: "self", state: "active" },
    expected: {
      scope: "self",
      state: "active",
      filter: [
        { field: "statusCategory", op: "in", values: ["to_do", "in_progress"] },
        { field: "assignee", op: "in", values: ["me"] },
      ],
    },
  },
  {
    name: "获取我已完成的工单",
    input: { scope: "self", state: "done" },
    expected: {
      scope: "self",
      state: "done",
      filter: [
        { field: "statusCategory", op: "in", values: ["done"] },
        { field: "assignee", op: "in", values: ["me"] },
      ],
    },
  },
] as const;

for (const { name, input, expected } of intentCases) {
  const normalized = normalizeTicketSearchInput(input);
  assert.equal(normalized.query.scope, expected.scope, `${name} must retain its resolved scope`);
  assert.equal(normalized.query.state, expected.state, `${name} must retain its resolved state`);
  assert.deepEqual(normalized.query.filter.all, expected.filter, `${name} must compile the expected controlled filters`);
}

const stateRefinement = normalizeTicketSearchInput({
  scope: "self",
  state: "all",
  where: { all: [{ field: "statusCategory", op: "in", values: ["done"] }] },
});
assert.deepEqual(stateRefinement.query.filter.all, [
  { field: "statusCategory", op: "in", values: ["done"] },
  { field: "assignee", op: "in", values: ["me"] },
]);

assert.throws(
  () => normalizeTicketSearchInput({ scope: "project", where: { all: [{ field: "assignee", op: "in", values: ["me"] }] } }),
  { name: "TicketError", message: /assignee may be used only with scope self/ },
  "project scope must not be combined with a current-user assignee filter",
);
assert.throws(
  () => normalizeTicketSearchInput({ scope: "self", state: "open", where: { all: [{ field: "statusCategory", op: "in", values: ["done"] }] } }),
  { name: "TicketError", message: /filters do not overlap/ },
  "a state refinement must not contradict the resolved state",
);
assert.throws(
  () => normalizeTicketSearchInput({ preset: "all" }),
  { name: "TicketError", message: /unsupported field preset/ },
  "the public input must use scope and state rather than an overloaded preset",
);

console.log("Ticket search intent normalization validates.");
