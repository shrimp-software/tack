import { z } from "zod";

import { ownDataValue as ownValue } from "../own-data.js";
import type { SourceKind } from "../source-kind.js";
import type { HttpServerConfig } from "../types.js";
import { ownStringRecord } from "./shared.js";

const HttpServerConfigSchema = z.object({
  transport: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional()
}) satisfies z.ZodType<HttpServerConfig>;

/** MCP servers reached over Streamable HTTP. */
export const httpSourceKind: SourceKind<HttpServerConfig> = {
  transport: "http",
  configSchema: HttpServerConfigSchema,
  connection(config) {
    const url = ownValue<string>(config, "url");
    if (typeof url !== "string") {
      return undefined;
    }

    const headers = ownStringRecord(config, "headers");
    return {
      transport: "http",
      url,
      ...(headers ? { headers } : {})
    };
  }
};
