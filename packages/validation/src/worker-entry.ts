import { handleValidationWorkerRequest, type ValidationWorkerRequest, type ValidationWorkerResponse, type ValidationWorkerStatsResponse, type ValidationWorkerFailure } from "./worker-handler.js";

type WorkerScope = {
  onmessage?: ((event: { readonly data: ValidationWorkerRequest }) => void) | undefined;
  postMessage?: (value: ValidationWorkerResponse | ValidationWorkerStatsResponse | ValidationWorkerFailure) => void;
};

type ParentPort = {
  on: (event: "message", listener: (request: ValidationWorkerRequest) => void) => void;
  postMessage: (response: ValidationWorkerResponse | ValidationWorkerStatsResponse | ValidationWorkerFailure) => void;
};

let parentPort: ParentPort | undefined;
try {
  // Bun supports this Node-compatible module as well as its native Worker
  // surface. Native web-worker fallback keeps the entry usable in Bun builds
  // that choose the browser-compatible worker implementation.
  const imported = await import("node:worker_threads");
  parentPort = imported.parentPort ?? undefined;
} catch {
  parentPort = undefined;
}

if (parentPort) {
  parentPort.on("message", (request) => parentPort?.postMessage(handleValidationWorkerRequest(request)));
} else {
  const scope = globalThis as unknown as WorkerScope;
  scope.onmessage = (event) => scope.postMessage?.(handleValidationWorkerRequest(event.data));
}
