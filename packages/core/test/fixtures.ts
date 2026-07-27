import {
  buildManifest,
  createTackResult,
  type TackConfig,
  type TackManifest,
  type TackRuntime
} from "../src/index.js";

export function fakeRuntime(
  calls: Array<{ toolId: string; args: unknown }>
): TackRuntime {
  return {
    invoke: async (toolId, args) => {
      calls.push({ toolId, args });
      return createTackResult({
        content: [{ type: "text", text: JSON.stringify({ toolId, args }) }],
        structuredContent: { toolId, args },
        isError: false
      });
    },
    close: async () => {}
  };
}

export function grafanaManifest(): TackManifest {
  const config: TackConfig = {
    servers: {
      grafana: {
        transport: "stdio",
        command: "grafana-mcp"
      }
    }
  };

  return buildManifest(
    config,
    [
      {
        serverId: "grafana",
        tools: [
          {
            name: "alerting_manage_rules",
            description: "Manage Grafana alerting rules.",
            inputSchema: {
              type: "object",
              properties: {
                operation: { type: "string", enum: ["list", "get"] },
                rule_uid: {
                  type: "string",
                  description: "Rule unique identifier."
                }
              },
              required: ["operation"],
              additionalProperties: false
            }
          },
          {
            name: "list_datasources",
            description: "List Grafana data sources.",
            inputSchema: {
              type: "object",
              additionalProperties: false
            }
          }
        ]
      }
    ],
    new Date("2026-07-23T00:00:00.000Z")
  );
}
