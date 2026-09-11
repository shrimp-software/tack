import { describe, expect, it } from "vitest";

import { grafanaManifest } from "../../core/test/fixtures.js";
import { buildAmbientDts } from "../src/ambient.js";
import { createTypeChecker } from "../src/index.js";

describe("buildAmbientDts", () => {
  it("inlines interfaces + the tools block for the manifest", async () => {
    const dts = await buildAmbientDts(grafanaManifest());
    expect(dts).toContain("declare global {");
    expect(dts).toContain('readonly "grafana": {');
    expect(dts).toContain("type CodeModeResult<T> =");
    expect(dts).toContain("export interface GrafanaAlertingRulesListInput");
    expect(dts).toContain("declare const fetch: never;");
    // schema-less output stays unknown
    expect(dts).toMatch(/export type Grafana\w*Output = unknown;/);
  });

  it("honors policy", async () => {
    const dts = await buildAmbientDts(grafanaManifest(), { deniedOperations: ["grafana.datasources.*"] });
    expect(dts).toContain('readonly "alerting": {');
    expect(dts).not.toContain("GrafanaDatasourcesListInput");
  });
});

describe("createTypeChecker", () => {
  const checker = createTypeChecker({ manifest: grafanaManifest() });

  it("types the collapsed result and rejects removed payload fields", async () => {
    expect(await checker.check([
      "const result = await tools.grafana.datasources.list();",
      "if (result.ok && result.responseId) {",
      "  return result.data;",
      "}",
      "return null;"
    ].join("\n"))).toEqual({ diagnostics: [] });
    const old = await checker.check("const result = await tools.grafana.datasources.list(); if (result.ok) return [result.raw, result.text, result.delivery];");
    expect(old.diagnostics.filter(d => d.code === "TS2339")).toHaveLength(3);
  });

  it("flags an unknown argument key (with a suggestion)", async () => {
    const out = await checker.check(
      'await tools.grafana.alerting.rules.list({ rule_uidx: "x" });'
    );
    expect(out.skipped).toBeFalsy();
    expect(out.diagnostics).toHaveLength(1);
    const d = out.diagnostics[0]!;
    expect(d.code).toBe("TS2561");
    expect(d.message).toContain("rule_uid");
    expect(d.line).toBe(1);
    expect(d.column).toBeGreaterThan(1);
  });

  it("flags a missing await", async () => {
    const out = await checker.check(
      "const r = tools.grafana.datasources.list();\nif (r.ok && r.delivery === 'inline') emit(r.data);"
    );
    expect(out.diagnostics.some((d) => d.code === "TS2339" && d.line === 2)).toBe(true);
  });

  it("flags an undefined name", async () => {
    const out = await checker.check("return notDefined;");
    expect(out.diagnostics).toHaveLength(1);
    const d = out.diagnostics[0]!;
    expect(d.code).toMatch(/^TS2(304|552)$/); // "cannot find name" / "did you mean"
    expect(d.line).toBe(1);
    expect(d.message).toContain("notDefined");
  });

  it("passes clean code that uses lib globals, await and emit", async () => {
    const out = await checker.check(
      [
        "const rows = await Promise.all([tools.grafana.datasources.list()]);",
        "const first = rows[0];",
        "if (first.ok) emit(first.data);",
        "return Array.from(rows).length;"
      ].join("\n")
    );
    expect(out).toEqual({ diagnostics: [] });
  });

  it("is warm after the first check (informational)", async () => {
    await checker.check("return 1;");
    const t = performance.now();
    await checker.check("return 2;");
    const ms = performance.now() - t;
    expect(ms).toBeLessThan(200);
  });
});

describe("createTypeChecker — graceful skip", () => {
  it("returns { skipped: true } instead of throwing on an internal failure", async () => {
    // A manifest that makes buildAmbientDts throw (external $ref rejection).
    const bad = {
      version: "0.1",
      generatedAt: "1970-01-01T00:00:00.000Z",
      servers: { s: { id: "s", transport: "stdio", tools: ["s.x"] } },
      tools: {
        "s.x": {
          id: "s.x",
          serverId: "s",
          namespaceName: "s",
          sdkName: "x",
          upstreamName: "x",
          inputSchema: { type: "object", properties: { a: { $ref: "https://example.com/e.json" } } }
        }
      }
    } as unknown as Parameters<typeof createTypeChecker>[0]["manifest"];

    const out = await createTypeChecker({ manifest: bad }).check("return 1;");
    expect(out.skipped).toBe(true);
    expect(out.diagnostics).toEqual([]);
  });
});
