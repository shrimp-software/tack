#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const statePath = process.env["TACK_FLAKY_STATE"];
if (statePath && !existsSync(statePath)) {
  writeFileSync(statePath, "failed-once\n", "utf8");
  process.exit(1);
}

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
      serverInfo: { name: "flaky-tack-mcp", version: "0.1.0" }
    });
    return;
  }

  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [
        {
          name: "echo",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false
          }
        }
      ]
    });
    return;
  }

  if (message.method === "tools/call" && message.params?.name === "echo") {
    const args = message.params?.arguments ?? {};
    respond(message.id, {
      content: [{ type: "text", text: args.message }],
      structuredContent: { message: args.message },
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
