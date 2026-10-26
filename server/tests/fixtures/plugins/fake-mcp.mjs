// An MCP server that answers from recorded tool results. Imported by tests, or
// run as `node fake-mcp.mjs <tools.json>` to serve over stdio.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * tools: [{name, readOnly?, results: [CallToolResult, …]}]; a tool answers its
 * results in order and then repeats the last one. Every call lands in `calls`.
 */
export function mcpServer(tools, calls = []) {
  const server = new Server({ name: "fake-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
  const used = new Map();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name, inputSchema: { type: "object" },
      ...(t.readOnly === undefined ? {} : { annotations: { readOnlyHint: t.readOnly } }),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    calls.push({ tool: req.params.name, input: req.params.arguments ?? {} });
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) return { content: [{ type: "text", text: `no tool ${req.params.name}` }], isError: true };
    const n = used.get(tool.name) ?? 0;
    used.set(tool.name, n + 1);
    return tool.results[Math.min(n, tool.results.length - 1)];
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tools = JSON.parse(readFileSync(process.argv[2], "utf8"));
  await mcpServer(tools).connect(new StdioServerTransport());
}
