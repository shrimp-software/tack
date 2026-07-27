#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

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
      serverInfo: { name: "env-tack-mcp", version: "0.1.0" }
    });
    return;
  }

  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [
        {
          name: "check_env",
          description: "Report test environment visibility",
          inputSchema: {
            type: "object",
            additionalProperties: false
          },
          outputSchema: {
            type: "object",
            properties: {
              leaked: { type: ["string", "null"] },
              scoped: { type: ["string", "null"] }
            },
            required: ["leaked", "scoped"],
            additionalProperties: false
          }
        }
      ]
    });
    return;
  }

  if (message.method === "tools/call" && message.params?.name === "check_env") {
    respond(message.id, {
      content: [{ type: "text", text: "env checked" }],
      structuredContent: {
        leaked: process.env["TACK_TEST_LEAK_SECRET"] ?? null,
        scoped: process.env["TACK_TEST_SCOPED_SECRET"] ?? null
      },
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
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`
  );
}
