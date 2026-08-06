#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./bootstrap/create-server.js";

/** 启动 stdio MCP 服务，并将协议传输交给组合完成的服务实例。 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("Failed to start MCP server:", error);
  process.exitCode = 1;
});
