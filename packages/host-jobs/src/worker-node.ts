import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("job_worker_parent_missing");
const request = workerData as { module: string; exportName: string };
const imported = await import(request.module);
const handler = imported[request.exportName] as ((input: unknown, context: { deadline: number; kind: string }) => unknown | Promise<unknown>) | undefined;
if (typeof handler !== "function") throw new Error("job_handler_export_missing");

parentPort.on("message", async (job: { jobId: string; input: unknown; kind: string; deadline: number }) => {
  try {
    const value = await handler(job.input, { deadline: job.deadline, kind: job.kind });
    parentPort?.postMessage({ jobId: job.jobId, ok: true, valueJson: safeJson(value) });
  } catch (error) {
    parentPort?.postMessage({ jobId: job.jobId, ok: false, error: error instanceof Error ? error.message.slice(0, 512) : "job_handler_failed" });
  }
});

function safeJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(input: unknown): string {
    if (input === null) return "null";
    if (typeof input === "string") return JSON.stringify(input);
    if (typeof input === "boolean") return input ? "true" : "false";
    if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== "object") throw new Error("job_handler_non_json_result");
    if (seen.has(input)) throw new Error("job_handler_cyclic_result");
    const prototype = Object.getPrototypeOf(input); seen.add(input);
    let result: string;
    if (Array.isArray(input)) {
      const parts: string[] = [];
      for (let index = 0; index < input.length; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(input, String(index)); if (!descriptor || !("value" in descriptor)) throw new Error("job_handler_accessor_result"); parts.push(encode(descriptor.value)); }
      result = `[${parts.join(",")}]`;
    } else {
      if (prototype !== Object.prototype && prototype !== null) throw new Error("job_handler_non_plain_result");
      result = `{${Object.keys(input).sort().map((key) => { const descriptor = Object.getOwnPropertyDescriptor(input, key); if (!descriptor || !("value" in descriptor)) throw new Error("job_handler_accessor_result"); return `${JSON.stringify(key)}:${encode(descriptor.value)}`; }).join(",")}}`;
    }
    seen.delete(input); return result;
  }
  return encode(value);
}
