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
      serverInfo: { name: "fake-tack-mcp", version: "0.1.0" }
    });
    return;
  }

  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [
        {
          name: "echo",
          description: "Echo text",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false
          },
          outputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false
          }
        },
        {
          name: "add",
          description: "Add two numbers",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" }
            },
            required: ["a", "b"],
            additionalProperties: false
          },
          outputSchema: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
            additionalProperties: false
          }
        },
        {
          name: "manage_rules",
          description: "Manage rules",
          inputSchema: {
            type: "object",
            properties: {
              operation: { type: "string", enum: ["list", "get"] },
              rule_uid: { type: "string" }
            },
            required: ["operation"],
            additionalProperties: false
          },
          outputSchema: {
            type: "object",
            properties: {
              args: { type: "object" }
            },
            required: ["args"],
            additionalProperties: false
          }
        }
      ]
    });
    return;
  }

  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};

    if (name === "echo") {
      respond(message.id, {
        content: [{ type: "text", text: args.message }],
        structuredContent: { message: args.message },
        isError: false
      });
      return;
    }

    if (name === "add") {
      const value = Number(args.a) + Number(args.b);
      respond(message.id, {
        content: [{ type: "text", text: JSON.stringify({ value }) }],
        structuredContent: { value },
        isError: false
      });
      return;
    }

    if (name === "manage_rules") {
      respond(message.id, {
        content: [{ type: "text", text: JSON.stringify({ args }) }],
        structuredContent: { args },
        isError: false
      });
      return;
    }
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
