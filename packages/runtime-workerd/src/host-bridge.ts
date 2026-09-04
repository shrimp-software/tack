import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { errorMessage, isToolDispatchError, type ToolInvoker } from "@cbxss/tack-codemode";

import { closeServer } from "./process.js";

export function startHostBridge(input: {
  readonly token: string;
  readonly invoker: ToolInvoker;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly signal: AbortSignal;
}): Promise<{ readonly port: number; readonly hasActiveToolCall: () => boolean; readonly close: () => Promise<void> }> {
  let activeToolCalls = 0;
  const server = createServer((request, response) => {
    void handleHostRequest({ ...input, beginToolCall: () => { activeToolCalls += 1; }, endToolCall: () => { activeToolCalls -= 1; } }, request, response);
  });

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.signal.removeEventListener("abort", abort);
      server.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const abort = () => {
      cleanup();
      void closeServer(server);
      reject(input.signal.reason);
    };

    if (input.signal.aborted) {
      abort();
      return;
    }

    server.on("error", onError);
    input.signal.addEventListener("abort", abort, { once: true });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        cleanup();
        resolve({
          port: address.port,
          hasActiveToolCall: () => activeToolCalls > 0,
          close: () => closeServer(server)
        });
        return;
      }
      cleanup();
      reject(new Error("host bridge did not expose a TCP port"));
    });
  });
}

async function handleHostRequest(
  options: {
    readonly token: string;
    readonly invoker: ToolInvoker;
    readonly maxRequestBytes: number;
    readonly maxResponseBytes: number;
    readonly signal: AbortSignal;
    readonly beginToolCall: () => void;
    readonly endToolCall: () => void;
  },
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/tool") {
    writeJson(response, 404, { ok: false, error: "not found" });
    return;
  }

  if (request.headers["x-tack-token"] !== options.token) {
    writeJson(response, 401, { ok: false, error: "unauthorized" });
    return;
  }

  try {
    const body = await readBody(request, options.maxRequestBytes);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      writeJson(response, 400, { ok: false, error: "invalid tool request" });
      return;
    }

    const path = (body as Record<string, unknown>)["path"];
    if (typeof path !== "string" || path.length === 0) {
      writeJson(response, 400, { ok: false, error: "path is required" });
      return;
    }

    options.beginToolCall();
    let result: unknown;
    try {
      result = await options.invoker.invoke({
        path,
        args: (body as Record<string, unknown>)["args"] ?? {},
        signal: options.signal
      });
    } finally {
      options.endToolCall();
    }
    writeJsonLimited(response, 200, { ok: true, result }, options.maxResponseBytes);
  } catch (error) {
    writeJson(response, 200, {
      ok: false,
      error: errorMessage(error),
      ...(isToolDispatchError(error) ? { code: error.code } : {})
    });
  }
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) {
        return;
      }

      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        settled = true;
        reject(new Error(`Tool bridge request exceeded ${maxBytes} bytes`));
        return;
      }

      body += chunk;
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    request.on("end", () => {
      if (settled) {
        return;
      }

      settled = true;
      try {
        resolve(body.length > 0 ? JSON.parse(body) as unknown : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeJsonLimited(
  response: ServerResponse,
  status: number,
  body: unknown,
  maxBytes: number
): void {
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > maxBytes) {
    writeJson(response, 200, {
      ok: false,
      error: `Tool bridge response exceeded ${maxBytes} bytes`
    });
    return;
  }

  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
}
