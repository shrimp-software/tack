const scope = globalThis as unknown as {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  postMessage(message: unknown): void;
};

let handler: ((input: unknown, context: { deadline: number; kind: string }) => unknown | Promise<unknown>) | undefined;
let initializing: Promise<void> | undefined;
scope.onmessage = async (event) => {
  const message = event.data as { module?: string; exportName?: string; jobId?: string; input?: unknown; kind?: string; deadline?: number };
  try {
    if (!handler) {
      if (!message.module || !message.exportName) throw new Error("job_handler_module_missing");
      initializing ??= (async () => {
        const imported = await import(message.module!);
        handler = imported[message.exportName!] as typeof handler;
        if (typeof handler !== "function") throw new Error("job_handler_export_missing");
      })();
      await initializing;
    }
    if (!message.jobId) return;
    const activeHandler = handler;
    if (!activeHandler) throw new Error("job_handler_export_missing");
    const value = await activeHandler(message.input, { deadline: message.deadline ?? Number.MAX_SAFE_INTEGER, kind: message.kind ?? "registered" });
    scope.postMessage({ jobId: message.jobId, ok: true, valueJson: safeJson(value) });
  } catch (error) {
    scope.postMessage({ jobId: message.jobId, ok: false, error: error instanceof Error ? error.message.slice(0, 512) : "job_handler_failed" });
  }
};

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
