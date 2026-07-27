import { describe, expect, it, vi } from "vitest";
import { createQuickJSRuntime } from "@tack/runtime-quickjs";
import { fakeRuntime, grafanaManifest } from "../../core/test/fixtures.js";

const stdioMock = vi.hoisted(() => {
  const state: {
    factory: undefined | (() => unknown);
    serveStdio: ReturnType<typeof vi.fn>;
  } = {
    factory: undefined,
    serveStdio: vi.fn((factory: () => unknown) => {
      state.factory = factory;
      return {
        close: vi.fn(async () => {})
      };
    })
  };

  return state;
});

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: stdioMock.serveStdio
}));

describe("MCP stdio server", () => {
  it("snapshots options before deferred stdio factory creation", async () => {
    const { serveTackMcpStdio } = await import("../src/stdio.js");
    const options = {
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 })
    };

    serveTackMcpStdio(options);
    Object.defineProperties(options, {
      manifest: {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error("manifest getter should not run");
        }
      },
      runtime: {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error("runtime getter should not run");
        }
      },
      codeRuntime: {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error("codeRuntime getter should not run");
        }
      }
    });

    expect(stdioMock.serveStdio).toHaveBeenCalledTimes(1);
    expect(() => stdioMock.factory?.()).not.toThrow();
  });
});
