#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const statePath = process.env["TACK_ABORTABLE_STATE"];
if (statePath) appendFileSync(statePath, `pid:${process.pid}\n`, "utf8");

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (!("id" in message)) return;
  if (message.method === "initialize") {
    respond(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "abortable", version: "0.1.0" } });
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, { tools: [{ name: "echo", inputSchema: { type: "object" } }] });
    return;
  }
  if (message.method === "tools/call" && message.params?.name === "echo") {
    if (message.params.arguments?.message === "hang") {
      if (statePath) appendFileSync(statePath, "call:hang\n", "utf8");
      return;
    }
    respond(message.id, { content: [{ type: "text", text: String(message.params.arguments?.message) }], isError: false });
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } })}\n`);
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
