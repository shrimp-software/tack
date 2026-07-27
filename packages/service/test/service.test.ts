import type { CodeRuntime } from "@tack/codemode";
import { createQuickJSRuntime } from "@tack/runtime-quickjs";
import { createWorkerdRuntime } from "@tack/runtime-workerd";
import { afterEach, describe, expect, it } from "vitest";
import { fakeRuntime, grafanaManifest } from "../../core/test/fixtures.js";

import { listenTackHttpService, type TackHttpServiceHandle } from "../src/index.js";

let handle: TackHttpServiceHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("Tack HTTP service", () => {
  it("refuses an unisolated code runtime by default", () => {
    expect(() =>
      listenTackHttpService({
        manifest: grafanaManifest(),
        runtime: fakeRuntime([]),
        codeRuntime: unsafeCodeRuntime(),
        users: [
          {
            id: "agent-a",
            token: "secret-a"
          }
        ]
      }, { port: 0 })
    ).toThrow(/refuses code runtime/);
  });

  it("ignores accessor service user entries", () => {
    const users: unknown[] = [];
    Object.defineProperty(users, "0", {
      enumerable: true,
      get() {
        throw new Error("service user getter should not run");
      }
    });

    expect(() =>
      listenTackHttpService({
        manifest: grafanaManifest(),
        runtime: fakeRuntime([]),
        codeRuntime: createWorkerdRuntime({ timeoutMs: 5_000 }),
        users: users as Parameters<typeof listenTackHttpService>[0]["users"]
      }, { port: 0 })
    ).toThrow("Tack HTTP service requires at least one configured user token");
  });

  it("ignores accessor service user auth fields", async () => {
    const user = {
      id: "agent-a"
    };
    Object.defineProperty(user, "token", {
      enumerable: true,
      get() {
        throw new Error("service user token getter should not run");
      }
    });
    handle = await listenTackHttpService({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime: createWorkerdRuntime({ timeoutMs: 5_000 }),
      users: [
        user as Parameters<typeof listenTackHttpService>[0]["users"][number]
      ]
    }, { port: 0 });

    expect(await status("/search", "secret-a", { query: "datasources" })).toBe(401);
  });

  it("ignores accessor service user policy fields", async () => {
    const user = {
      id: "agent-a",
      token: "secret-a"
    };
    Object.defineProperty(user, "deniedOperations", {
      enumerable: true,
      get() {
        throw new Error("service user deniedOperations getter should not run");
      }
    });
    handle = await listenTackHttpService({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime: createWorkerdRuntime({ timeoutMs: 5_000 }),
      users: [
        user as Parameters<typeof listenTackHttpService>[0]["users"][number]
      ]
    }, { port: 0 });

    const search = await json("/search", "secret-a", { query: "rules" });

    expect(search).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ path: "grafana.alerting.rules.list" })
      ])
    });
  });

  it("does not read live service option fields during request handling", async () => {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const options = {
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls),
      codeRuntime: createWorkerdRuntime({ timeoutMs: 5_000 }),
      users: [
        {
          id: "agent-a",
          token: "secret-a"
        }
      ]
    };
    handle = await listenTackHttpService(options, { port: 0 });
    for (const key of ["manifest", "runtime", "codeRuntime", "policy", "maxRequestBytes", "onAuditEvent"] as const) {
      Object.defineProperty(options, key, {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error(`${key} getter should not run`);
        }
      });
    }

    const search = await json("/search", "secret-a", { query: "datasources" });
    expect(search).toMatchObject({
      items: [expect.objectContaining({ path: "grafana.datasources.list" })]
    });

    const executed = await json("/execute", "secret-a", {
      code: "return tools.grafana.datasources.list();"
    });
    expect(executed).toMatchObject({
      ok: true,
      result: {
        ok: true,
        data: { toolId: "grafana.list_datasources" }
      }
    });
    expect(calls).toEqual([{ toolId: "grafana.list_datasources", args: {} }]);
  });

  it("executes requests with the QuickJS vm-isolated runtime", async () => {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    handle = await listenTackHttpService({
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls),
      codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 }),
      users: [
        {
          id: "agent-a",
          token: "secret-a"
        }
      ]
    }, { port: 0 });

    const executed = await json("/execute", "secret-a", {
      code: "return tools.grafana.datasources.list();"
    });

    expect(executed).toMatchObject({
      ok: true,
      result: {
        ok: true,
        data: { toolId: "grafana.list_datasources" }
      },
      trace: {
        runtime: "quickjs",
        isolation: "vm"
      }
    });
    expect(calls).toEqual([{ toolId: "grafana.list_datasources", args: {} }]);
  });

  it("does not read live service user or rate-limit fields during request handling", async () => {
    const userRateLimit = {
      requests: 10,
      windowMs: 60_000
    };
    const defaultRateLimit = {
      requests: 10,
      windowMs: 60_000
    };
    const user = {
      id: "agent-a",
      token: "secret-a",
      deniedOperations: ["grafana.alerting.*"],
      rateLimit: userRateLimit
    };
    handle = await listenTackHttpService({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime: createWorkerdRuntime({ timeoutMs: 5_000 }),
      rateLimit: defaultRateLimit,
      users: [user]
    }, { port: 0 });
    for (const key of ["id", "token", "deniedOperations", "rateLimit"] as const) {
      Object.defineProperty(user, key, {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error(`user ${key} getter should not run`);
        }
      });
    }
    for (const target of [userRateLimit, defaultRateLimit]) {
      for (const key of ["requests", "windowMs"] as const) {
        Object.defineProperty(target, key, {
          configurable: true,
          enumerable: true,
          get() {
            throw new Error(`rate ${key} getter should not run`);
          }
        });
      }
    }

    const search = await json("/search", "secret-a", { query: "rules" });

    expect(search).toMatchObject({ items: [] });
  });

  it("rejects request bodies over the configured size limit", async () => {
    handle = await listenTackHttpService({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime: createWorkerdRuntime({ timeoutMs: 5_000 }),
      maxRequestBytes: 16,
      users: [
        {
          id: "agent-a",
          token: "secret-a"
        }
      ]
    }, { port: 0 });

    const response = await fetch(`${handle.url}/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-a"
      },
      body: JSON.stringify({ query: "this body is intentionally too large" })
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "request_too_large",
      maxRequestBytes: 16
    });
  });

  it("describes allowed tools through execute without exposing denied tools", async () => {
    handle = await listenTackHttpService({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime: createWorkerdRuntime({ timeoutMs: 5_000 }),
      users: [
        {
          id: "agent-a",
          token: "secret-a",
          allowedOperations: ["grafana.datasources.*"]
        }
      ]
    }, { port: 0 });

    const allowed = await json("/execute", "secret-a", {
      code: "return tools.describe.tool({ path: 'grafana.datasources.list' });"
    });
    expect(allowed).toMatchObject({
      ok: true,
      result: {
        path: "grafana.datasources.list",
        description: "List Grafana data sources.",
        inputTypeScript: expect.stringContaining("export interface GrafanaDatasourcesListInput")
      }
    });

    const denied = await json("/execute", "secret-a", {
      code: "return tools.describe.tool({ path: 'grafana.alerting.rules.list' });"
    });
    expect(denied).toMatchObject({
      ok: true,
      result: {
        error: {
          code: "tool_not_found",
          suggestions: ["grafana.datasources.list"]
        }
      }
    });

    expect(await status("/describe", "secret-a", { path: "grafana.datasources.list" })).toBe(404);
    expect(await status("/guide", "secret-a", { name: "execute" })).toBe(404);
  });

  it("requires auth, enforces user policy, rate limits, and audits with user identity", async () => {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const audits: unknown[] = [];
    handle = await listenTackHttpService({
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls),
      codeRuntime: createWorkerdRuntime({ timeoutMs: 5_000 }),
      policy: {
        allowedOperations: ["grafana.*"]
      },
      users: [
        {
          id: "agent-a",
          token: "secret-a",
          deniedOperations: ["grafana.alerting.*"],
          rateLimit: {
            requests: 2,
            windowMs: 60_000
          }
        }
      ],
      onAuditEvent: (event) => {
        audits.push(event);
      }
    }, { port: 0 });

    expect(await status("/search", undefined, { query: "datasources" })).toBe(401);

    const search = await json("/search", "secret-a", { query: "rules" });
    expect(search).toMatchObject({ items: [] });

    const denied = await json("/execute", "secret-a", {
      code: "return tools.grafana.alerting.rules.list();"
    });
    expect(denied).toMatchObject({
      ok: true,
      result: {
        ok: false,
        error: {
          message: expect.stringContaining("denied by policy")
        }
      }
    });
    expect(calls).toEqual([]);
    expect(audits).toEqual([
      expect.objectContaining({
        userId: "agent-a",
        path: "grafana.alerting.rules.list",
        allowed: false,
        ok: false
      })
    ]);

    expect(await status("/search", "secret-a", { query: "datasources" })).toBe(429);
  });
});

async function status(path: string, token: string | undefined, body: unknown): Promise<number> {
  const response = await fetch(`${handle?.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  return response.status;
}

async function json(path: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${handle?.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  return response.json() as Promise<unknown>;
}

function unsafeCodeRuntime(): CodeRuntime {
  return {
    name: "unsafe-test",
    isolation: "none",
    execute: () =>
      Promise.resolve({
        ok: true,
        emitted: [],
        logs: []
      })
  };
}
