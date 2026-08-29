import { z } from "zod";

import type { SourceKind } from "../source-kind.js";
import type { HttpServerConfig } from "../types.js";

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
    if (typeof config.url !== "string") {
      return undefined;
    }
    return {
      transport: "http",
      url: config.url,
      ...(config.headers && Object.keys(config.headers).length > 0 ? { headers: config.headers } : {})
    };
  }
};
