import readline from "node:readline";
import { appendFileSync } from "node:fs";
import { tools, result } from "./protocol.ts";
const log = event => { if (process.env.SDK_FIXTURE_LOG) appendFileSync(process.env.SDK_FIXTURE_LOG, `${JSON.stringify({ event, pid: process.pid, cwd: process.cwd() })}\n`); };
log("start");
process.on("exit", () => log("exit"));
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  const request = JSON.parse(line);
  if (!("id" in request)) return;
  const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: value })}\n`);
  if (request.method === "initialize") {
    log("initialize");
    const initialize = () => send({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "sdk-fixture", version: "1" } });
    if (process.env.SDK_FIXTURE_INIT_DELAY) setTimeout(initialize, Number(process.env.SDK_FIXTURE_INIT_DELAY));
    else initialize();
  }
  else if (request.method === "tools/list") { log("list"); send({ tools }); }
  else if (request.method === "tools/call") {
    log("call");
    const args = request.params.arguments;
    if (args.mode === "disconnect") process.exit(1);
    else if (args.mode !== "wait") send(result(process.env.SDK_FIXTURE_PREFIX ? { ...args, query: `${process.env.SDK_FIXTURE_PREFIX}${args.query}` } : args));
  }
});
