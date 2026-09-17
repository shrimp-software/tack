import { createServer } from "node:http";
import { tools, result } from "./protocol.js";

/** Local session-based HTTP MCP fixture, with controllable discovery/calls. */
export async function httpFixture(options: { listGate?: Promise<void>; failList?: boolean } = {}) {
  const events: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const sessions = new Set<string>();
  let nextSession = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") {
      events.push("delete"); sessions.delete(String(req.headers["mcp-session-id"]));
      res.writeHead(200).end(); return;
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { arguments: Record<string, unknown> } };
    events.push(message.method);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const send = (value: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value }));
    };
    if (message.method === "initialize") {
      const session = String(++nextSession); sessions.add(session);
      res.setHeader("mcp-session-id", session);
      send({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "sdk-http-fixture", version: "1" } });
    } else if (message.method === "tools/list") {
      await options.listGate;
      if (options.failList) { res.writeHead(500).end("fixture list failed"); return; }
      send({ tools });
    } else if (message.method === "tools/call") {
      const args = message.params?.arguments ?? {};
      requests.push(args);
      if (args.mode === "disconnect") res.destroy();
      else if (args.mode === "wait") res.on("close", () => events.push("aborted"));
      else send(result(args));
    } else res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, events, requests, sessions,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    })
  };
}
