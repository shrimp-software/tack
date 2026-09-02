import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createMcpRuntime, discoverMcpManifestPromise } from "../src/index.js";
import { StreamableHttpMcpClient } from "../src/http-client.js";
import type { TackConfig, TackManifest } from "@cbxss/tack-core";

const here = dirname(fileURLToPath(import.meta.url));
const fakeServer = join(here, "fixtures", "fake-mcp-server.mjs");
const envServer = join(here, "fixtures", "env-mcp-server.mjs");
const flakyServer = join(here, "fixtures", "flaky-mcp-server.mjs");

describe("MCP adapter", () => {
  it("discovers and invokes Streamable HTTP tools from an MCP URL", async () => {
    const previousToken = process.env["TACK_HTTP_TEST_TOKEN"];
    process.env["TACK_HTTP_TEST_TOKEN"] = "server-token";
    const server = await startFakeHttpMcpServer();
    const headers = Object.create({
      inherited: "not forwarded"
    }) as Record<string, string>;
    Object.defineProperties(headers, {
      authorization: {
        value: "Bearer ${TACK_HTTP_TEST_TOKEN}",
        enumerable: true
      },
      poison: {
        enumerable: true,
        get: () => {
          throw new Error("header getter should not run");
        }
      }
    });

    try {
      const config: TackConfig = {
        servers: {
          remote: {
            transport: "http",
            url: server.url,
            headers
          }
        }
      };

      const manifest = await discoverMcpManifestPromise(config);

      expect(manifest.servers["remote"]).toMatchObject({
        transport: "http",
        url: server.url
      });
      expect(Object.keys(manifest.tools)).toEqual([
        "remote.add",
        "remote.echo"
      ]);

      const runtime = await createMcpRuntime({ config, manifest });
      try {
        const result = await runtime.invoke("remote.add", { a: 2, b: 4 });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({ value: 6 });
      } finally {
        await runtime.close();
      }
    } finally {
      await server.close();
      restoreEnv("TACK_HTTP_TEST_TOKEN", previousToken);
    }
  });

  it("rejects Streamable HTTP JSON-RPC responses with mismatched ids", async () => {
    const server = await startMismatchedIdHttpMcpServer();
    const config: TackConfig = {
      servers: {
        remote: {
          transport: "http",
          url: server.url
        }
      }
    };

    try {
      await discoverMcpManifestPromise(config);
      throw new Error("Expected discovery to reject");
    } catch (error) {
      expect(error).toMatchObject({
        message: "Failed to discover MCP server remote",
        serverId: "remote"
      });
      expect((error as { readonly cause?: Error }).cause?.message)
        .toBe("MCP HTTP response did not include response id 1");
    } finally {
      await server.close();
    }
  });

  it("normalizes direct Streamable HTTP client config and call inputs", async () => {
    const previousToken = process.env["TACK_HTTP_TEST_TOKEN"];
    process.env["TACK_HTTP_TEST_TOKEN"] = "server-token";
    const server = await startFakeHttpMcpServer();
    const headers = {
      authorization: "Bearer ${TACK_HTTP_TEST_TOKEN}"
    };
    Object.defineProperty(headers, "poison", {
      enumerable: true,
      get() {
        throw new Error("header getter should not run");
      }
    });
    const config = {
      transport: "http" as const,
      url: server.url,
      headers
    };
    const client = new StreamableHttpMcpClient(config);
    for (const key of ["url", "headers"] as const) {
      Object.defineProperty(config, key, {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error(`config ${key} getter should not run`);
        }
      });
    }
    Object.defineProperty(headers, "authorization", {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error("authorization getter should not run");
      }
    });
    const args = { a: 2, b: 4 };
    Object.defineProperty(args, "poison", {
      enumerable: true,
      get() {
        throw new Error("argument getter should not run");
      }
    });

    try {
      await client.connect();
      const result = await client.callTool({
        name: "add",
        arguments: args
      });

      expect(result).toMatchObject({
        structuredContent: { value: 6 },
        isError: false
      });
    } finally {
      await client.close();
      await server.close();
      restoreEnv("TACK_HTTP_TEST_TOKEN", previousToken);
    }
  });

  it("skips malformed discovered HTTP tool entries and metadata", async () => {
    const server = await startMalformedToolsHttpMcpServer();
    const config: TackConfig = {
      servers: {
        remote: {
          transport: "http",
          url: server.url
        }
      }
    };

    try {
      const manifest = await discoverMcpManifestPromise(config);

      expect(Object.keys(manifest.tools)).toEqual(["remote.echo"]);
      expect(manifest.tools["remote.echo"]).toMatchObject({
        upstreamName: "echo",
        inputSchema: { type: "object" }
      });
      expect(manifest.tools["remote.echo"]?.description).toBeUndefined();
      expect(manifest.tools["remote.echo"]?.outputSchema).toBeUndefined();
      expect(manifest.tools["remote.echo"]?.annotations).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("discovers and invokes stdio tools", async () => {
    const config: TackConfig = {
      servers: {
        fake: {
          transport: "stdio",
          command: "node",
          args: [fakeServer]
        }
      }
    };

    const manifest = await discoverMcpManifestPromise(config);

    expect(Object.keys(manifest.tools)).toEqual([
      "fake.add",
      "fake.echo",
      "fake.manage_rules"
    ]);
    expect(manifest.tools["fake.add"]?.upstreamName).toBe("add");

    const runtime = await createMcpRuntime({ config, manifest });
    try {
      const result = await runtime.invoke("fake.add", { a: 2, b: 3 });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({ value: 5 });
      expect(result.json()).toEqual({ value: 5 });
    } finally {
      await runtime.close();
    }
  });

  it("does not read live runtime option fields during invocation", async () => {
    const previousToken = process.env["TACK_HTTP_TEST_TOKEN"];
    process.env["TACK_HTTP_TEST_TOKEN"] = "server-token";
    const server = await startFakeHttpMcpServer();
    const config: TackConfig = {
      servers: {
        remote: {
          transport: "http",
          url: server.url,
          headers: {
            authorization: "Bearer ${TACK_HTTP_TEST_TOKEN}"
          }
        }
      }
    };

    try {
      const manifest = await discoverMcpManifestPromise(config);
      const options = { config, manifest };
      const runtime = await createMcpRuntime(options);
      const servers = config.servers;
      const tools = manifest.tools;
      Object.defineProperty(options, "config", {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error("config getter should not run");
        }
      });
      Object.defineProperty(options, "manifest", {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error("manifest getter should not run");
        }
      });
      Object.defineProperty(config, "servers", {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error("config servers getter should not run");
        }
      });
      Object.defineProperty(servers, "remote", {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error("server config getter should not run");
        }
      });
      Object.defineProperty(manifest, "tools", {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error("manifest tools getter should not run");
        }
      });
      Object.defineProperty(tools, "remote.add", {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error("tool metadata getter should not run");
        }
      });

      try {
        const result = await runtime.invoke("remote.add", { a: 2, b: 4 });
        expect(result.structuredContent).toEqual({ value: 6 });
      } finally {
        await runtime.close();
      }
    } finally {
      await server.close();
      restoreEnv("TACK_HTTP_TEST_TOKEN", previousToken);
    }
  });

  it("does not leak parent process env into stdio servers by default", async () => {
    const previousLeak = process.env["TACK_TEST_LEAK_SECRET"];
    const previousScoped = process.env["TACK_TEST_SCOPED_SECRET"];
    process.env["TACK_TEST_LEAK_SECRET"] = "parent-secret";
    delete process.env["TACK_TEST_SCOPED_SECRET"];
    const env = Object.create({
      TACK_TEST_LEAK_SECRET: "inherited-secret"
    }) as Record<string, string>;
    Object.defineProperties(env, {
      TACK_TEST_SCOPED_SECRET: {
        value: "server-secret",
        enumerable: true
      },
      POISON: {
        enumerable: true,
        get: () => {
          throw new Error("env getter should not run");
        }
      }
    });

    try {
      const config: TackConfig = {
        servers: {
          env: {
            transport: "stdio",
            command: process.execPath,
            args: [envServer],
            env
          }
        }
      };

      const manifest = await discoverMcpManifestPromise(config);
      const runtime = await createMcpRuntime({ config, manifest });

      try {
        const result = await runtime.invoke("env.check_env", {});
        expect(result.structuredContent).toEqual({
          leaked: null,
          scoped: "server-secret"
        });
      } finally {
        await runtime.close();
      }
    } finally {
      restoreEnv("TACK_TEST_LEAK_SECRET", previousLeak);
      restoreEnv("TACK_TEST_SCOPED_SECRET", previousScoped);
    }
  });

  it("can explicitly inherit parent process env for stdio servers", async () => {
    const previousLeak = process.env["TACK_TEST_LEAK_SECRET"];
    process.env["TACK_TEST_LEAK_SECRET"] = "parent-secret";

    try {
      const config: TackConfig = {
        servers: {
          env: {
            transport: "stdio",
            command: process.execPath,
            args: [envServer],
            inheritEnv: true
          }
        }
      };

      const manifest = await discoverMcpManifestPromise(config);
      expect(manifest.servers["env"]?.inheritEnv).toBe(true);

      const runtime = await createMcpRuntime({ config, manifest });

      try {
        const result = await runtime.invoke("env.check_env", {});
        expect(result.structuredContent).toEqual({
          leaked: "parent-secret",
          scoped: null
        });
      } finally {
        await runtime.close();
      }
    } finally {
      restoreEnv("TACK_TEST_LEAK_SECRET", previousLeak);
    }
  });

  it("retries a server connection after an initial startup failure", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "tack-flaky-mcp-"));
    const statePath = join(tmp, "state");
    const config: TackConfig = {
      servers: {
        flaky: {
          transport: "stdio",
          command: process.execPath,
          args: [flakyServer],
          env: {
            TACK_FLAKY_STATE: statePath
          }
        }
      }
    };
    const manifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        flaky: {
          id: "flaky",
          transport: "stdio",
          command: process.execPath,
          args: [flakyServer],
          env: {
            TACK_FLAKY_STATE: statePath
          },
          tools: ["flaky.echo"]
        }
      },
      tools: {
        "flaky.echo": {
          id: "flaky.echo",
          serverId: "flaky",
          namespaceName: "flaky",
          sdkName: "echo",
          upstreamName: "echo",
          inputSchema: { type: "object" }
        }
      }
    } as const;
    const runtime = await createMcpRuntime({ config, manifest });

    try {
      await expect(runtime.invoke("flaky.echo", { message: "first" })).rejects.toThrow();

      const result = await runtime.invoke("flaky.echo", { message: "second" });
      expect(result.structuredContent).toEqual({ message: "second" });
    } finally {
      await runtime.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("normalizes invocation arguments to own enumerable data properties", async () => {
    const config: TackConfig = {
      servers: {
        fake: {
          transport: "stdio",
          command: "node",
          args: [fakeServer]
        }
      }
    };
    const manifest = await discoverMcpManifestPromise(config);
    const args = Object.create({
      inherited: "not forwarded"
    }) as Record<string, unknown>;
    Object.defineProperties(args, {
      rule_uid: {
        value: "abc",
        enumerable: true
      },
      "__proto__": {
        value: "own proto data",
        enumerable: true
      },
      poison: {
        enumerable: true,
        get: () => {
          throw new Error("argument getter should not run");
        }
      },
      nonEnumerable: {
        value: "not forwarded",
        enumerable: false
      }
    });

    const runtime = await createMcpRuntime({ config, manifest });
    try {
      const result = await runtime.invoke("fake.manage_rules", args);
      expect(result.structuredContent).toEqual({
        args: {
          rule_uid: "abc",
          "__proto__": "own proto data"
        }
      });
    } finally {
      await runtime.close();
    }
  });

  it("does not invoke inherited manifest tool entries", async () => {
    const tools = Object.create({
      "ghost.echo": {
        id: "ghost.echo",
        serverId: "ghost",
        namespaceName: "ghost",
        sdkName: "echo",
        upstreamName: "echo",
        inputSchema: { type: "object" }
      }
    }) as TackManifest["tools"];
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {},
      tools
    };
    const config: TackConfig = {
      servers: {}
    };
    const runtime = await createMcpRuntime({ config, manifest });

    try {
      await expect(runtime.invoke("ghost.echo", {})).rejects.toThrow("Unknown Tack tool: ghost.echo");
    } finally {
      await runtime.close();
    }
  });

  it("does not invoke manifest tools whose runtime metadata is inherited or mismatched", async () => {
    const inheritedMetadataTool = Object.assign(
      Object.create({
        serverId: "ghost",
        upstreamName: "echo"
      }),
      {
        id: "ghost.echo",
        namespaceName: "ghost",
        sdkName: "echo",
        inputSchema: { type: "object" }
      }
    );
    const config: TackConfig = {
      servers: {
        ghost: {
          transport: "stdio",
          command: process.execPath,
          args: [fakeServer]
        }
      }
    };
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        ghost: {
          id: "ghost",
          transport: "stdio",
          tools: ["ghost.echo", "ghost.duplicate"]
        }
      },
      tools: {
        "ghost.echo": inheritedMetadataTool,
        "ghost.duplicate": {
          id: "ghost.echo",
          serverId: "ghost",
          namespaceName: "ghost",
          sdkName: "duplicate",
          upstreamName: "echo",
          inputSchema: { type: "object" }
        }
      }
    };
    const runtime = await createMcpRuntime({ config, manifest });

    try {
      await expect(runtime.invoke("ghost.echo", {})).rejects.toThrow(
        "Invalid Tack tool metadata for ghost.echo"
      );
      await expect(runtime.invoke("ghost.duplicate", {})).rejects.toThrow(
        "Invalid Tack tool metadata for ghost.duplicate"
      );
    } finally {
      await runtime.close();
    }
  });

  it("does not invoke manifest tools whose runtime metadata uses getters", async () => {
    const getterMetadataTool = {
      id: "ghost.echo",
      namespaceName: "ghost",
      sdkName: "echo",
      inputSchema: { type: "object" },
      get serverId(): string {
        throw new Error("serverId getter should not run");
      },
      get upstreamName(): string {
        throw new Error("upstreamName getter should not run");
      }
    };
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        ghost: {
          id: "ghost",
          transport: "stdio",
          tools: ["ghost.echo"]
        }
      },
      tools: {
        "ghost.echo": getterMetadataTool
      }
    };
    const config: TackConfig = {
      servers: {}
    };
    const runtime = await createMcpRuntime({ config, manifest });

    try {
      await expect(runtime.invoke("ghost.echo", {})).rejects.toThrow(
        "Invalid Tack tool metadata for ghost.echo"
      );
    } finally {
      await runtime.close();
    }
  });

  it("does not discover config server entries whose own value is an accessor", async () => {
    const servers = {};
    Object.defineProperty(servers, "ghost", {
      enumerable: true,
      get() {
        throw new Error("server config getter should not run");
      }
    });
    const config: TackConfig = {
      servers: servers as TackConfig["servers"]
    };

    const manifest = await discoverMcpManifestPromise(config);

    expect(Object.keys(manifest.servers)).toEqual([]);
    expect(Object.keys(manifest.tools)).toEqual([]);
  });

  it("does not connect to inherited config server entries", async () => {
    const servers = Object.create({
      ghost: {
        transport: "stdio",
        command: process.execPath,
        args: [fakeServer]
      }
    }) as TackConfig["servers"];
    const config: TackConfig = {
      servers
    };
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        ghost: {
          id: "ghost",
          transport: "stdio",
          tools: ["ghost.echo"]
        }
      },
      tools: {
        "ghost.echo": {
          id: "ghost.echo",
          serverId: "ghost",
          namespaceName: "ghost",
          sdkName: "echo",
          upstreamName: "echo",
          inputSchema: { type: "object" }
        }
      }
    };
    const runtime = await createMcpRuntime({ config, manifest });

    try {
      await expect(runtime.invoke("ghost.echo", {})).rejects.toThrow("No config found for server ghost");
    } finally {
      await runtime.close();
    }
  });

  it("does not connect to config server entries whose own value is an accessor", async () => {
    const servers = {};
    Object.defineProperty(servers, "ghost", {
      enumerable: true,
      get() {
        throw new Error("server config getter should not run");
      }
    });
    const config: TackConfig = {
      servers: servers as TackConfig["servers"]
    };
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        ghost: {
          id: "ghost",
          transport: "stdio",
          tools: ["ghost.echo"]
        }
      },
      tools: {
        "ghost.echo": {
          id: "ghost.echo",
          serverId: "ghost",
          namespaceName: "ghost",
          sdkName: "echo",
          upstreamName: "echo",
          inputSchema: { type: "object" }
        }
      }
    };
    const runtime = await createMcpRuntime({ config, manifest });

    try {
      await expect(runtime.invoke("ghost.echo", {})).rejects.toThrow("No config found for server ghost");
    } finally {
      await runtime.close();
    }
  });

  it("does not open server configs whose connection fields are inherited", async () => {
    const inheritedCommandConfig = Object.assign(
      Object.create({
        command: process.execPath,
        args: [fakeServer]
      }),
      {
        transport: "stdio"
      }
    ) as TackConfig["servers"][string];
    const config: TackConfig = {
      servers: {
        ghost: inheritedCommandConfig
      }
    };
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        ghost: {
          id: "ghost",
          transport: "stdio",
          tools: ["ghost.echo"]
        }
      },
      tools: {
        "ghost.echo": {
          id: "ghost.echo",
          serverId: "ghost",
          namespaceName: "ghost",
          sdkName: "echo",
          upstreamName: "echo",
          inputSchema: { type: "object" }
        }
      }
    };
    const runtime = await createMcpRuntime({ config, manifest });

    try {
      await expect(runtime.invoke("ghost.echo", {})).rejects.toThrow(
        "Invalid stdio MCP server config: missing command"
      );
    } finally {
      await runtime.close();
    }
  });

  it("does not open server configs whose connection fields use getters", async () => {
    const getterCommandConfig = {
      transport: "stdio",
      get command(): string {
        throw new Error("command getter should not run");
      },
      args: [fakeServer]
    } as unknown as TackConfig["servers"][string];
    const config: TackConfig = {
      servers: {
        ghost: getterCommandConfig
      }
    };
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        ghost: {
          id: "ghost",
          transport: "stdio",
          tools: ["ghost.echo"]
        }
      },
      tools: {
        "ghost.echo": {
          id: "ghost.echo",
          serverId: "ghost",
          namespaceName: "ghost",
          sdkName: "echo",
          upstreamName: "echo",
          inputSchema: { type: "object" }
        }
      }
    };
    const runtime = await createMcpRuntime({ config, manifest });

    try {
      await expect(runtime.invoke("ghost.echo", {})).rejects.toThrow(
        "Invalid stdio MCP server config: missing command"
      );
    } finally {
      await runtime.close();
    }
  });

  it("does not open server configs whose args entries use getters", async () => {
    const args = [fakeServer];
    Object.defineProperty(args, "0", {
      enumerable: true,
      get() {
        throw new Error("args entry getter should not run");
      }
    });
    const config: TackConfig = {
      servers: {
        ghost: {
          transport: "stdio",
          command: process.execPath,
          args
        }
      }
    };
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        ghost: {
          id: "ghost",
          transport: "stdio",
          tools: ["ghost.echo"]
        }
      },
      tools: {
        "ghost.echo": {
          id: "ghost.echo",
          serverId: "ghost",
          namespaceName: "ghost",
          sdkName: "echo",
          upstreamName: "echo",
          inputSchema: { type: "object" }
        }
      }
    };
    const runtime = await createMcpRuntime({ config, manifest });

    try {
      await expect(runtime.invoke("ghost.echo", {})).rejects.toThrow(
        "Invalid MCP server config: args must be a string array"
      );
    } finally {
      await runtime.close();
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

async function startFakeHttpMcpServer(): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    void handleFakeHttpMcpRequest(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("fake HTTP MCP server did not bind a port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

async function startMismatchedIdHttpMcpServer(): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        response.writeHead(404);
        response.end();
        return;
      }

      await readJson(request);
      writeJson(response, 200, {
        jsonrpc: "2.0",
        id: "wrong",
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {}
        }
      });
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("mismatched-id HTTP MCP server did not bind a port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

async function startMalformedToolsHttpMcpServer(): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    void handleMalformedToolsHttpMcpRequest(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("malformed-tools HTTP MCP server did not bind a port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

async function handleFakeHttpMcpRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.headers["authorization"] !== "Bearer server-token") {
    writeJson(response, 401, {
      jsonrpc: "2.0",
      error: { code: -32001, message: "unauthorized" }
    });
    return;
  }

  if (request.method === "DELETE") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== "POST" || request.url !== "/mcp") {
    response.writeHead(404);
    response.end();
    return;
  }

  const message = await readJson(request);
  if (!("id" in message)) {
    response.writeHead(202);
    response.end();
    return;
  }

  if (message.method === "initialize") {
    response.setHeader("mcp-session-id", "session-1");
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: {
          tools: {
            listChanged: true
          }
        },
        serverInfo: {
          name: "fake-http",
          version: "1.0.0"
        }
      }
    });
    return;
  }

  if (request.headers["mcp-session-id"] !== "session-1") {
    writeJson(response, 400, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32002, message: "missing session" }
    });
    return;
  }

  if (message.method === "tools/list") {
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: {
                message: { type: "string" }
              },
              required: ["message"]
            }
          },
          {
            name: "add",
            inputSchema: {
              type: "object",
              properties: {
                a: { type: "number" },
                b: { type: "number" }
              },
              required: ["a", "b"]
            }
          }
        ]
      }
    });
    return;
  }

  if (message.method === "tools/call") {
    const params = message.params;
    if (params?.name === "add") {
      const args = params.arguments ?? {};
      writeJson(response, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }],
          structuredContent: { value: Number(args.a) + Number(args.b) },
          isError: false
        }
      });
      return;
    }
  }

  writeJson(response, 200, {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "method not found" }
  });
}

async function handleMalformedToolsHttpMcpRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/mcp") {
    response.writeHead(404);
    response.end();
    return;
  }

  const message = await readJson(request);
  if (!("id" in message)) {
    response.writeHead(202);
    response.end();
    return;
  }

  if (message.method === "initialize") {
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: {}
      }
    });
    return;
  }

  if (message.method === "tools/list") {
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          null,
          { description: "missing name" },
          { name: 123 },
          {
            name: "echo",
            description: 123,
            inputSchema: { type: "object" },
            outputSchema: ["not", "object"],
            annotations: ["not", "object"]
          }
        ]
      }
    });
    return;
  }

  writeJson(response, 200, {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "method not found" }
  });
}

function readJson(request: IncomingMessage): Promise<{
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: {
    readonly name?: string;
    readonly arguments?: Record<string, unknown>;
  };
}> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("error", reject);
    request.on("end", () => {
      resolve(JSON.parse(body) as {
        readonly id?: string | number;
        readonly method?: string;
        readonly params?: {
          readonly name?: string;
          readonly arguments?: Record<string, unknown>;
        };
      });
    });
  });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
