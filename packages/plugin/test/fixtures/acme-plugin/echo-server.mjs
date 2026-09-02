#!/usr/bin/env node
// Minimal stdio MCP server for the plugin fixture: one `echo` tool.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  if (!("id" in message)) {
    return;
  }

  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "acme-echo", version: "0.1.0" }
    });
    return;
  }

  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [
        {
          name: "echo",
          description: "Echo text back",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false
          },
          outputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false
          }
        }
      ]
    });
    return;
  }

  if (message.method === "tools/call" && message.params?.name === "echo") {
    const text = message.params?.arguments?.text ?? "";
    respond(message.id, {
      content: [{ type: "text", text }],
      structuredContent: { text },
      isError: false
    });
    return;
  }

  respondError(message.id, -32601, `Unknown method: ${message.method}`);
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
