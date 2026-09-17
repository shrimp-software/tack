import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildManifest, createTackResult, type TackRuntime } from "@cbxss/tack-core";
import { createRuntime, discoverManifest } from "@cbxss/tack-sources";
import { Tack } from "../src/index.js";

vi.mock("@cbxss/tack-sources", async importOriginal => {
  const actual = await importOriginal<typeof import("@cbxss/tack-sources")>();
  return { ...actual, discoverManifest: vi.fn(), createRuntime: vi.fn() };
});

const config = { servers: { local: { transport: "module" as const, entry: "/fixture.ts" } } };
const manifest = buildManifest(config, [{ serverId: "local", tools: [{ name: "echo", inputSchema: { type: "object" } }] }]);
const clients: Tack[] = [];
function client() { const tack = new Tack({ config }); clients.push(tack); return tack; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.mocked(discoverManifest).mockReset().mockResolvedValue(manifest);
  vi.mocked(createRuntime).mockReset();
});
afterEach(async () => { await Promise.all(clients.splice(0).map(tack => tack.close())); });

it("never allocates for close-before-use, including immediate call/close races", async () => {
  const tack = client();
  const pending = tack.call("local.echo");
  const checked = expect(pending).rejects.toMatchObject({ code: "cancelled", upstreamOutcome: "not_started" });
  await tack.close(); await checked;
  expect(discoverManifest).not.toHaveBeenCalled();
  expect(createRuntime).not.toHaveBeenCalled();
});

it("closes a runtime that finishes allocating after close began, exactly once", async () => {
  const allocating = deferred<TackRuntime>();
  const close = vi.fn(async () => undefined);
  const invoke = vi.fn() as unknown as TackRuntime["invoke"];
  vi.mocked(createRuntime).mockReturnValue(allocating.promise);
  const tack = client();
  const ready = tack.ready();
  const checked = expect(ready).rejects.toMatchObject({ code: "client_closed" });
  await expect.poll(() => vi.mocked(createRuntime).mock.calls.length).toBe(1);
  let closed = false;
  const closing = tack.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  allocating.resolve({ invoke, close });
  await closing; await checked;
  expect(close).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
});

it("observes late rejected work after cancellation even for uncooperative modules", async () => {
  const work = deferred<ReturnType<typeof createTackResult>>();
  const close = vi.fn(async () => undefined);
  const invoke = vi.fn(() => work.promise) as unknown as TackRuntime["invoke"];
  vi.mocked(createRuntime).mockResolvedValue({ invoke, close });
  const tack = client();
  await tack.ready();
  const pending = tack.call("local.echo", {}, { timeoutMs: 10 });
  await expect(pending).rejects.toMatchObject({ code: "tool_timeout", upstreamOutcome: "unknown" });
  work.reject(new Error("late fixture rejection"));
  await tack.close();
  expect(close).toHaveBeenCalledTimes(1);
  // Vitest reports unhandled rejections as failures; late work stays observed.
});

it("canonical lookup cannot be shadowed by another namespace's relative alias", async () => {
  const collisionConfig = { servers: {
    first: { transport: "module" as const, entry: "/fixture.ts" },
    local: { transport: "module" as const, entry: "/fixture.ts" }
  } };
  vi.mocked(discoverManifest).mockResolvedValue(buildManifest(collisionConfig, [
    { serverId: "first", tools: [{ name: "shadow", path: ["local", "echo"], inputSchema: { type: "object" } }] },
    { serverId: "local", tools: [{ name: "echo", inputSchema: { type: "object" } }] }
  ]));
  const invoke = vi.fn(async (toolId: string) => createTackResult({ structuredContent: { toolId } })) as unknown as TackRuntime["invoke"];
  vi.mocked(createRuntime).mockResolvedValue({ invoke, close: async () => undefined });
  const tack = client();
  await expect(tack.call("local.echo")).resolves.toMatchObject({ data: { toolId: "local.echo" } });
  expect((await tack.describe("local.echo")).name).toBe("echo");
});

it("uses configured downstream timeouts by default and replaces them with caller deadlines", async () => {
  const invoke: TackRuntime["invoke"] = async <T>(_toolId: string, _args: unknown, options?: { signal?: AbortSignal | undefined }) => {
    await new Promise<void>((resolve, reject) => {
      const signal = options?.signal;
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 25);
      const abort = () => { clearTimeout(timer); reject(signal?.reason); };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
    return createTackResult<T>({ structuredContent: { delivered: true } });
  };
  vi.mocked(createRuntime).mockResolvedValue({ invoke, close: async () => undefined });
  const tack = new Tack({ config: { ...config, runtime: { toolTimeoutMs: 5 } } }); clients.push(tack);
  await tack.ready();
  await expect(tack.call("local.echo")).rejects.toMatchObject({ code: "tool_timeout", upstreamOutcome: "unknown" });
  await expect(tack.call("local.echo", {}, { timeoutMs: 100 })).resolves.toMatchObject({ data: { delivered: true } });
});

it("reserved prototype paths remain callable explicitly without unsafe dot properties", async () => {
  vi.mocked(discoverManifest).mockResolvedValue(buildManifest(config, [{ serverId: "local", tools: [
    { name: "serialize", path: ["toJSON"], inputSchema: { type: "object" } },
    { name: "construct", path: ["constructor"], inputSchema: { type: "object" } }
  ] }]));
  const invoke = vi.fn(async (toolId: string) => createTackResult({ structuredContent: { toolId } })) as unknown as TackRuntime["invoke"];
  vi.mocked(createRuntime).mockResolvedValue({ invoke, close: async () => undefined });
  const tack = client();
  expect(tack.tools["local"]!["toJSON"]).toBeUndefined();
  expect(tack.tools["local"]!["constructor"]).toBeUndefined();
  await expect(tack.call("local.toJSON")).resolves.toMatchObject({ data: { toolId: "local.serialize" } });
  await expect(tack.call("local.constructor")).resolves.toMatchObject({ data: { toolId: "local.construct" } });
});
