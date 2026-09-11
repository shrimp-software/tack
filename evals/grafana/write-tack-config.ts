#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "../.local/tack.grafana-mock.config.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      servers: {
        grafana: {
          transport: "stdio",
          command: process.execPath,
          args: [resolve(here, "server.ts")],
        },
      },
      runtime: {
        type: "quickjs",
        timeoutMs: 120000,
        maxToolCalls: 80,
        maxOutputBytes: 2000000,
        maxToolResponseBytes: 8000000,
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${output}`);
