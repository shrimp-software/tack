import { Worker } from "node:worker_threads";

export type RuntimeName = "node" | "bun" | "unknown";
export type RuntimeCapabilityStatus = "available" | "unsupported" | "unverified";
export type RuntimeCapabilityName = "worker-memory-limit";

export interface RuntimeCapabilityEvidence {
  readonly runtime: RuntimeName;
  readonly capability: RuntimeCapabilityName;
  readonly status: RuntimeCapabilityStatus;
  readonly evidence: readonly string[];
  readonly uncertainty: readonly string[];
}

export interface RuntimeCapabilityProbeOptions {
  readonly probeModule?: string | URL;
  readonly timeoutMs?: number;
}

const CAPABILITY: RuntimeCapabilityName = "worker-memory-limit";
const PROBE_TIMEOUT_MS = 1_000;
const DEFAULT_PROBE_MODULE = new URL("data:text/javascript,import%20%7BparentPort%7D%20from%20%22node%3Aworker_threads%22%3BparentPort%3F.postMessage(%7Bkind%3A%22tack-runtime-capability-probe%22%2Cprotocol%3A1%2Cruntime%3A%22node%22%7D)%3BparentPort%3F.close()%3BsetInterval(()%3D%3Eundefined%2C60000)%3B");

/**
 * Probe only the trusted host runtime capability surface. This does not
 * allocate toward a limit and does not claim an RSS or enforcement proof.
 */
export async function probeRuntimeCapabilities(options: RuntimeCapabilityProbeOptions = {}): Promise<RuntimeCapabilityEvidence> {
  const runtime = runtimeName();
  if (runtime === "bun") return { runtime, capability: CAPABILITY, status: "unsupported", evidence: ["Bun runtime identified", "Bun Worker has no hard memory-bound option exposed by the current host API"], uncertainty: ["Bun#98 remains open", "memory enforcement and RSS are unverified"] };
  if (runtime !== "node") return { runtime, capability: CAPABILITY, status: "unverified", evidence: ["runtime was not recognized as Node or Bun"], uncertainty: ["no runtime-specific worker capability probe was selected"] };
  const probeModule = options.probeModule ?? DEFAULT_PROBE_MODULE;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > PROBE_TIMEOUT_MS) return { runtime, capability: CAPABILITY, status: "unverified", evidence: ["probe timeout was outside the bounded probe range"], uncertainty: ["trusted capability probe did not run"] };
  const worker = new Worker(probeModule, { execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type") && !argument.startsWith("--max-old-space-size")), resourceLimits: { maxOldGenerationSizeMb: 16 } });
  let acknowledged = false;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error("runtime_capability_probe_timeout")), timeoutMs);
      const finish = (error?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(); };
      worker.once("message", (message: unknown) => {
        if (message && typeof message === "object" && (message as { kind?: unknown }).kind === "tack-runtime-capability-probe" && (message as { protocol?: unknown }).protocol === 1 && (message as { runtime?: unknown }).runtime === "node") { acknowledged = true; finish(); return; }
        finish(new Error("runtime_capability_probe_invalid_ack"));
      });
      worker.once("error", finish);
      worker.once("exit", (code) => { if (code !== 0) finish(new Error(`runtime_capability_probe_exit:${code}`)); });
    });
    if (!acknowledged) return { runtime, capability: CAPABILITY, status: "unverified", evidence: ["Node probe exited without a valid capability acknowledgment"], uncertainty: ["resource limit enforcement was not verified"] };
    return { runtime, capability: CAPABILITY, status: "available", evidence: ["Node Worker accepted the bounded resourceLimits configuration", "trusted probe worker acknowledged the Node protocol", "trusted probe worker was owned by and closed by the host probe"], uncertainty: ["this is an API capability result, not an OOM, RSS, or memory-enforcement proof"] };
  } catch (error) {
    return { runtime, capability: CAPABILITY, status: "unverified", evidence: ["trusted Node worker capability probe failed"], uncertainty: [error instanceof Error ? error.message : "unknown probe failure", "resource limit enforcement was not verified"] };
  } finally {
    await worker.terminate();
  }
}

/** Fail closed: only a positive, runtime-specific available result may gate a future caller. */
export function requireRuntimeCapability(result: RuntimeCapabilityEvidence, capability: RuntimeCapabilityName = CAPABILITY): void {
  if (result.runtime !== "node" || result.capability !== capability || result.status !== "available") throw new Error(`runtime_capability_unavailable:${capability}:${result.status}`);
}

export function runtimeCapabilityAvailable(result: RuntimeCapabilityEvidence, capability: RuntimeCapabilityName = CAPABILITY): boolean {
  return result.runtime === "node" && result.capability === capability && result.status === "available";
}

function runtimeName(): RuntimeName {
  if (typeof process !== "undefined" && typeof process.versions?.bun === "string") return "bun";
  if (typeof process !== "undefined" && typeof process.versions?.node === "string") return "node";
  return "unknown";
}
