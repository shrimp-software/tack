import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import { CodeRuntimeTimeoutError } from "@cbxss/tack-codemode";

import { closeServer, runWorker } from "../src/process.js";

describe("workerd process runner", () => {
  it("times out a response that sends headers but never finishes its body", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":');
    });
    await listen(server);
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("test server did not expose a TCP port");
    }

    try {
      await expect(runWorker({
        port: address.port,
        timeoutMs: 50,
        isPaused: () => false,
        signal: new AbortController().signal
      })).rejects.toBeInstanceOf(CodeRuntimeTimeoutError);
    } finally {
      await closeServer(server);
    }
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}
