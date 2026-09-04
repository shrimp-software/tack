import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { TackConfig } from "@cbxss/tack-core";

import { createRuntime, discoverManifest } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const abortableServer = join(here, "../../mcp/test/fixtures/abortable-mcp-server.mjs");

describe("aggregate runtime cancellation", () => {
  it("forwards aborts to a stdio MCP runtime and reconnects on the next call", async () => {
    const root = await mkdtemp(join(tmpdir(), "tack-sources-cancellation-"));
    const statePath = join(root, "state.txt");
    const config: TackConfig = {
      servers: {
        abortable: {
          transport: "stdio",
          command: process.execPath,
          args: [abortableServer],
          env: { TACK_ABORTABLE_STATE: statePath }
        }
      }
    };
    const manifest = await discoverManifest(config);
    const runtime = await createRuntime({ config, manifest });
    const controller = new AbortController();

    try {
      const pending = runtime.invoke("abortable.echo", { message: "hang" }, { signal: controller.signal });
      await waitForStateLine(statePath, "call:hang");
      controller.abort(new Error("cancelled for test"));

      await expect(pending).rejects.toThrow("Connection closed");
      await expect(runtime.invoke("abortable.echo", { message: "fresh" })).resolves.toMatchObject({ isError: false });
      const pids = (await readFile(statePath, "utf8"))
        .split("\n")
        .filter((line) => line.startsWith("pid:"));
      expect(pids).toHaveLength(3);
      expect(pids[1]).not.toBe(pids[2]);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitForStateLine(path: string, line: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readFile(path, "utf8").catch(() => "");
    if (state.split("\n").includes(line)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${line}`);
}
