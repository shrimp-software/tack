#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const evalRoot = dirname(here);
const outputPath = resolve(evalRoot, ".local/tack.kibana.config.json");
const kibanaMcpUrl = process.env.KIBANA_MCP_URL ?? "http://localhost:5601/api/agent_builder/mcp";
const kibanaApiKey = process.env.KIBANA_API_KEY;

const config = {
  servers: {
    kibana: {
      transport: "http",
      url: kibanaMcpUrl,
      ...(kibanaApiKey ? { headers: { Authorization: `ApiKey ${kibanaApiKey}` } } : {})
    }
  },
  runtime: {
    type: "quickjs",
    timeoutMs: 120_000,
    maxOutputBytes: 2_000_000,
    maxToolCalls: 80,
    maxToolRequestBytes: 1_000_000,
    maxToolResponseBytes: 2_000_000
  }
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote ${outputPath}`);
