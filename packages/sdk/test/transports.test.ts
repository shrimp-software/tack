import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { Tack, type TackConfig } from "../src/index.js";
import { httpFixture } from "./fixtures/http.js";

const stdio = fileURLToPath(new URL("./fixtures/stdio.mjs", import.meta.url));
const clients: Tack[] = [];
const servers: Awaited<ReturnType<typeof httpFixture>>[] = [];
const dirs: string[] = [];
function client(config: TackConfig) { const tack = new Tack({ config }); clients.push(tack); return tack; }
async function http(options: Parameters<typeof httpFixture>[0] = {}) {
  const server = await httpFixture(options); servers.push(server); return server;
}
async function temp(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "tack-sdk-wire-")); dirs.push(dir); return dir; }
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map(tack => tack.close()));
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })));
});

it("shares one HTTP discovery/runtime across concurrent first calls and closes sessions", async () => {
  const server = await http();
  const tack = client({ servers: { remote: { transport: "http", url: server.url } } });
  expect(server.events).toEqual([]);
  const results = await Promise.all([
    tack.tools["remote"]!["echo"]!({ query: "one" }),
    tack.call("remote.echo", { query: "two" }),
    tack.ready(), tack.search({ query: "echo" }), tack.describe("remote.echo")
  ]);
  expect(results[0]).toMatchObject({ data: { query: "one" }, upstreamOutcome: "succeeded", responseId: null });
  expect(results[1]).toMatchObject({ data: { query: "two" } });
  expect(server.events.filter(event => event === "tools/list")).toHaveLength(1);
  expect(server.events.filter(event => event === "initialize")).toHaveLength(2);
  await tack.call("remote.echo", { query: "three" });
  expect(server.events.filter(event => event === "initialize")).toHaveLength(2);
  expect(server.sessions.size).toBe(1);
  await tack.close();
  expect(server.sessions.size).toBe(0);
  expect(server.events.filter(event => event === "delete")).toHaveLength(2);
});

it("delivers structured, JSON text, plain text and null despite output mismatch", async () => {
  const server = await http();
  const tack = client({ servers: { remote: { transport: "http", url: server.url } } });
  for (const mode of ["structured", "json"]) {
    await expect(tack.call("remote.echo", { query: "hello", mode })).resolves.toMatchObject({ data: { query: "hello" } });
  }
  await expect(tack.call("remote.echo", { query: "plain text", mode: "text" })).resolves.toMatchObject({ data: "plain text" });
  await expect(tack.call("remote.echo", { query: "ignored", mode: "null" })).resolves.toMatchObject({ data: null });
  await expect(tack.call("remote.echo", { query: "failed", mode: "error" })).rejects.toMatchObject({ code: "tool_error", upstreamOutcome: "failed" });
});

it("never rewrites HTTP arguments, even when response normalization is opted in", async () => {
  const server = await http();
  const tack = client({ servers: { remote: { transport: "http", url: server.url } }, runtime: { normalizeWhitespace: ["remote"] } });
  const query = 'namespace:xservice  AND\n message:"hello  world"';
  const response = await tack.call("remote.echo", { query });
  expect(server.requests).toEqual([{ query }]);
  expect(response.data).not.toEqual({ query });
});

it("isolates cancellation while waiting for shared discovery", async () => {
  const list = gate();
  const server = await http({ listGate: list.promise });
  const tack = client({ servers: { remote: { transport: "http", url: server.url } } });
  const controller = new AbortController();
  const cancelled = tack.call("remote.echo", { query: "cancelled" }, { signal: controller.signal });
  const check = expect(cancelled).rejects.toMatchObject({ code: "cancelled", upstreamOutcome: "not_started" });
  const other = tack.call("remote.echo", { query: "other" });
  try {
    await expect.poll(() => server.events.includes("tools/list")).toBe(true);
    controller.abort();
    await check;
  } finally { list.release(); }
  await expect(other).resolves.toMatchObject({ data: { query: "other" } });
  expect(server.requests).toEqual([{ query: "other" }]);
  expect(server.events.filter(event => event === "tools/list")).toHaveLength(1);
});

it("close during discovery waits for temporary session cleanup and never dispatches", async () => {
  const list = gate();
  const server = await http({ listGate: list.promise });
  const tack = client({ servers: { remote: { transport: "http", url: server.url } } });
  const ready = tack.ready();
  const checked = expect(ready).rejects.toMatchObject({ code: "client_closed" });
  let closed = false;
  try {
    await expect.poll(() => server.events.includes("tools/list")).toBe(true);
    const closing = tack.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    list.release();
    await closing;
    await checked;
    expect(server.sessions.size).toBe(0);
    expect(server.events.filter(event => event === "initialize")).toHaveLength(1);
    expect(server.requests).toEqual([]);
  } finally { list.release(); }
});

it("failed discovery waits for sibling MCP resources and stays failed", async () => {
  const list = gate();
  const sibling = await http({ listGate: list.promise });
  const failing = await http({ failList: true });
  const tack = client({ servers: {
    failing: { transport: "http", url: failing.url }, sibling: { transport: "http", url: sibling.url }
  } });
  let settled = false;
  const pending = tack.ready().catch(error => { settled = true; return error; });
  try {
    await expect.poll(() => failing.events.includes("delete")).toBe(true);
    expect(settled).toBe(false);
  } finally { list.release(); }
  const failure = await pending;
  expect(failure).toMatchObject({ code: "initialization_failed", upstreamOutcome: "not_started" });
  expect(await tack.ready().catch(error => error)).toBe(failure);
  await tack.close();
  expect(sibling.sessions.size).toBe(0);
  expect(failing.sessions.size).toBe(0);
});

it("forwards HTTP cancellation/deadlines and preserves uncertain transport outcomes", async () => {
  const server = await http();
  const tack = client({ servers: { remote: { transport: "http", url: server.url } } });
  await tack.ready();
  await tack.call("remote.echo", { query: "warm" });
  await expect(tack.call("remote.echo", { query: "wait", mode: "wait" }, { timeoutMs: 250 })).rejects.toMatchObject({ code: "tool_timeout", upstreamOutcome: "unknown" });
  await expect.poll(() => server.events.includes("aborted")).toBe(true);
  await expect(tack.call("remote.echo", { query: "disconnect", mode: "disconnect" })).rejects.toMatchObject({ code: "downstream_error", upstreamOutcome: "unknown", cause: expect.any(Error) });
  expect(server.requests.filter(args => args.query === "disconnect")).toHaveLength(1);
  await expect(tack.call("remote.echo", { query: "still usable" })).resolves.toMatchObject({ data: { query: "still usable" } });
});

it("uses fixture stdio discovery and a pooled runtime with config-relative cwd", async () => {
  const dir = await temp();
  const log = join(dir, "events.jsonl");
  const configPath = join(dir, "tack.config.json");
  await writeFile(configPath, JSON.stringify({ servers: { local: {
    transport: "stdio", command: process.execPath, args: [stdio], cwd: ".", env: { SDK_FIXTURE_LOG: log }
  } } }));
  const tack = new Tack({ configPath }); clients.push(tack);
  const responses = await Promise.all([tack.call("local.echo", { query: "one" }), tack.call("local.echo", { query: "two" })]);
  expect(responses.map(response => response.data)).toEqual([{ query: "one" }, { query: "two" }]);
  await tack.call("local.echo", { query: "three" });
  await tack.close();
  const events = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { event: string; pid: number; cwd: string });
  expect(events.filter(event => event.event === "start")).toHaveLength(2);
  expect(events.filter(event => event.event === "list")).toHaveLength(1);
  expect(events.filter(event => event.event === "call")).toHaveLength(3);
  for (const event of events.filter(event => event.event === "start")) {
    expect(event.cwd).toBe(dir);
    expect(() => process.kill(event.pid, 0)).toThrow();
  }
}, 15_000);

it("stdio timeouts close the owned process, and transport failure is not replayed", async () => {
  const dir = await temp();
  const log = join(dir, "events.jsonl");
  const tack = client({ servers: { local: { transport: "stdio", command: process.execPath, args: [stdio], env: { SDK_FIXTURE_LOG: log } } } });
  await tack.ready();
  await tack.call("local.echo", { query: "warm" });
  await expect(tack.call("local.echo", { query: "wait", mode: "wait" }, { timeoutMs: 250 })).rejects.toMatchObject({ code: "tool_timeout", upstreamOutcome: "unknown" });
  await expect(tack.call("local.echo", { query: "disconnect", mode: "disconnect" })).rejects.toMatchObject({ code: "downstream_error", upstreamOutcome: "unknown" });
  await tack.close();
  const events = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { event: string; pid: number });
  expect(events.filter(event => event.event === "call")).toHaveLength(3);
  for (const event of events.filter(event => event.event === "start")) expect(() => process.kill(event.pid, 0)).toThrow();
}, 15_000);

it("supports config-relative plugin mounts, skills, and bundled stdio operations", async () => {
  const configDir = fileURLToPath(new URL("../../plugin/test/fixtures/", import.meta.url));
  const tack = new Tack({ config: { servers: {}, plugins: { acme: { path: "./acme-plugin" } } }, configDir });
  clients.push(tack);
  const description = await tack.describe("acme.mcp.echo.echo");
  expect(description.path).toBe("acme.mcp.echo.echo");
  await expect(tack.call("acme.mcp.echo.echo", { text: "plugin hello" })).resolves.toMatchObject({ data: { text: "plugin hello" } });
  const skill = await tack.call("acme.greet");
  expect(skill.data).toMatchObject({ name: "greet", instructions: expect.stringContaining("Hello") });
}, 15_000);

it("isolates two plugin mounts with colliding bundled server/tool names and policy", async () => {
  const root = await temp();
  for (const name of ["first", "second"]) {
    const dir = join(root, name);
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(join(dir, ".claude-plugin/plugin.json"), JSON.stringify({ name }));
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { same: {
      command: process.execPath, args: [stdio], env: { SDK_FIXTURE_PREFIX: `${name}:` }
    } } }));
  }
  const config: TackConfig = { servers: {}, plugins: { first: { path: "./first" }, second: { path: "./second" } } };
  const tack = new Tack({ config, configDir: root }); clients.push(tack);
  const responses = await Promise.all([
    tack.call("first.mcp.same.echo", { query: "value" }),
    tack.call("second.mcp.same.echo", { query: "value" })
  ]);
  expect(responses.map(response => response.data)).toEqual([{ query: "first:value" }, { query: "second:value" }]);
  const restricted = new Tack({ config: { ...config, security: { deniedOperations: ["second.mcp.same.echo"] } }, configDir: root });
  clients.push(restricted);
  await expect(restricted.call("second.mcp.same.echo", { query: "denied" })).rejects.toMatchObject({ code: "operation_denied", upstreamOutcome: "not_started" });
  await expect(restricted.call("first.mcp.same.echo", { query: "allowed" })).resolves.toMatchObject({ data: { query: "first:allowed" } });
  expect((await restricted.search()).items.map(item => item.path)).toEqual(["first.mcp.same.echo"]);
}, 15_000);

it("bounds each caller's initialization wait without stopping shared discovery", async () => {
  const list = gate();
  const server = await http({ listGate: list.promise });
  const tack = client({ servers: { remote: { transport: "http", url: server.url } } });
  const ready = tack.ready();
  try {
    await expect.poll(() => server.events.includes("tools/list")).toBe(true);
    const outcomes = await Promise.allSettled([
      tack.call("remote.echo", { query: "expired" }, { timeoutMs: 20 }),
      tack.search({ query: "echo" }, { timeoutMs: 20 }),
      tack.describe("remote.echo", { timeoutMs: 20 })
    ]);
    for (const outcome of outcomes) expect(outcome).toMatchObject({ status: "rejected", reason: { code: "tool_timeout", upstreamOutcome: "not_started" } });
    expect(server.requests).toEqual([]);
  } finally { list.release(); }
  await ready;
  await expect(tack.call("remote.echo", { query: "survivor" })).resolves.toMatchObject({ data: { query: "survivor" } });
  expect(server.events.filter(event => event === "tools/list")).toHaveLength(1);
});

it("does not retire another caller's shared stdio connection during lazy connection setup", async () => {
  const dir = await temp();
  const log = join(dir, "events.jsonl");
  const tack = client({ servers: { local: {
    transport: "stdio", command: process.execPath, args: [stdio],
    env: { SDK_FIXTURE_LOG: log, SDK_FIXTURE_INIT_DELAY: "200" }
  } } });
  await tack.ready();
  const controller = new AbortController();
  const cancelled = tack.call("local.echo", { query: "cancelled" }, { signal: controller.signal });
  const checked = expect(cancelled).rejects.toMatchObject({ code: "cancelled", upstreamOutcome: "unknown" });
  const other = tack.call("local.echo", { query: "survivor" });
  await expect.poll(async () => (await readFile(log, "utf8")).split("\n").filter(line => line.includes('"event":"initialize"')).length).toBe(2);
  controller.abort();
  await checked;
  await expect(other).resolves.toMatchObject({ data: { query: "survivor" } });
  await tack.close();
  const events = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { event: string });
  expect(events.filter(event => event.event === "call")).toHaveLength(1);
  expect(events.filter(event => event.event === "start")).toHaveLength(2);
}, 15_000);

it("does not apply model-facing response size limits to direct calls", async () => {
  const server = await http();
  const tack = client({ servers: { remote: { transport: "http", url: server.url } } });
  const query = "x".repeat(100_000);
  await expect(tack.call("remote.echo", { query })).resolves.toMatchObject({ data: { query } });
});
