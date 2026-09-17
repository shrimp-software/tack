import { beforeEach, expect, it, vi } from "vitest";
import { buildManifest, createTackResult, type TackRuntime } from "@cbxss/tack-core";
import { createPluginToolRuntime } from "@cbxss/tack-plugin";
import { pluginSource } from "../src/sources/plugin.js";

vi.mock("@cbxss/tack-plugin", async importOriginal => ({
  ...await importOriginal<typeof import("@cbxss/tack-plugin")>(),
  createPluginToolRuntime: vi.fn()
}));
const config = { servers: {
  first: { transport: "plugin" as const, path: "/first" },
  second: { transport: "plugin" as const, path: "/second" }
} };
const tools = Object.values(buildManifest(config, ["first", "second"].map(serverId => ({
  serverId, tools: [{ name: "echo", path: ["mcp", "same", "echo"], inputSchema: { type: "object" } }]
}))).tools);
beforeEach(() => { vi.mocked(createPluginToolRuntime).mockReset(); });

it("partitions mounts, routes canonical tool ids and closes every mount once", async () => {
  const closes = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
  vi.mocked(createPluginToolRuntime).mockImplementation(async ({ tools }) => ({
    invoke: (async (id: string) => createTackResult({ structuredContent: { id, mount: tools[0]!.serverId } })) as TackRuntime["invoke"],
    close: closes[tools[0]!.serverId === "first" ? 0 : 1]!
  }));
  const runtime = await pluginSource.createRuntime({ config, tools });
  for (const tool of tools) {
    expect((await runtime.invoke(tool.id, {})).structuredContent).toEqual({ id: tool.id, mount: tool.serverId });
  }
  expect(vi.mocked(createPluginToolRuntime).mock.calls.map(([input]) => input.tools.length)).toEqual([1, 1]);
  await runtime.close(); await runtime.close();
  for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  await expect(async () => runtime.invoke(tools[0]!.id, {})).rejects.toThrow("closed");
});

it("waits for late allocations and closes successful mounts after partial initialization failure", async () => {
  let release!: (runtime: TackRuntime) => void;
  const late = new Promise<TackRuntime>(resolve => { release = resolve; });
  const close = vi.fn(async () => undefined);
  const failure = new Error("second mount failed");
  vi.mocked(createPluginToolRuntime).mockImplementation(({ tools }) => tools[0]!.serverId === "first" ? late : Promise.reject(failure));
  let settled = false;
  const creating = Promise.resolve(pluginSource.createRuntime({ config, tools })).catch((error: unknown) => { settled = true; return error; });
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  release({ invoke: vi.fn() as TackRuntime["invoke"], close });
  expect(await creating).toBe(failure);
  expect(close).toHaveBeenCalledTimes(1);
});

it("awaits all mount cleanup even if one close rejects", async () => {
  let release!: () => void;
  const late = new Promise<void>(resolve => { release = resolve; });
  const failure = new Error("first close failed");
  vi.mocked(createPluginToolRuntime).mockImplementation(async ({ tools }) => ({
    invoke: vi.fn() as TackRuntime["invoke"],
    close: () => tools[0]!.serverId === "first" ? Promise.reject(failure) : late
  }));
  const runtime = await pluginSource.createRuntime({ config, tools });
  let settled = false;
  const closing = runtime.close().catch(error => { settled = true; return error; });
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  release();
  expect(await closing).toBe(failure);
});
