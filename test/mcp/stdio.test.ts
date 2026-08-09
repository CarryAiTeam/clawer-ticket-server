// Compiled-process MCP transport check.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
});
const client = new Client({ name: "stdio-smoke-test", version: "1.0.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "ticket_export"));
  assert.ok(tools.some((tool) => tool.name === "ticket_search"));
  assert.ok(!tools.some((tool) => tool.name === "ticket_my_open_tasks"));
  assert.ok(!tools.some((tool) => tool.name === "ticket_export_my_open_tasks"));
  assert.ok(tools.some((tool) => tool.name === "ticket_browser_connect"));
  assert.ok(tools.some((tool) => tool.name === "ticket_browser_disconnect"));
  console.log("MCP stdio smoke test passed.");
} finally {
  await transport.close();
}
