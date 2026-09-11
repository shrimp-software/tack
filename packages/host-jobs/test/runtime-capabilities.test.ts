import { describe, expect, test } from "vitest";
import { probeRuntimeCapabilities, requireRuntimeCapability, runtimeCapabilityAvailable, type RuntimeCapabilityEvidence } from "../dist/index.js";

const capability = "worker-memory-limit" as const;

describe("trusted runtime capability probe", () => {
  test("produces a runtime-specific Node result and gates only available", async () => {
    const result = await probeRuntimeCapabilities();
    expect(result.runtime).toBe("node");
    expect(result.status).toBe("available");
    expect(result.capability).toBe(capability);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.uncertainty.length).toBeGreaterThan(0);
    expect(runtimeCapabilityAvailable(result)).toBe(true);
    expect(() => requireRuntimeCapability(result)).not.toThrow();
  });

  test("fails closed for unsupported and unverified results", () => {
    const results: RuntimeCapabilityEvidence[] = [
      { runtime: "bun", capability, status: "available", evidence: ["structurally available only"], uncertainty: ["Bun#98 remains open"] },
      { runtime: "unknown", capability, status: "available", evidence: ["structurally available only"], uncertainty: ["runtime is unknown"] },
      { runtime: "bun", capability, status: "unsupported", evidence: ["Bun has no hard resource limit API"], uncertainty: ["Bun#98 remains open"] },
      { runtime: "unknown", capability, status: "unverified", evidence: ["runtime unknown"], uncertainty: ["no runtime-specific probe"] }
    ];
    for (const result of results) {
      expect(runtimeCapabilityAvailable(result)).toBe(false);
      expect(() => requireRuntimeCapability(result)).toThrow(`runtime_capability_unavailable:${capability}:${result.status}`);
    }
  });
});
