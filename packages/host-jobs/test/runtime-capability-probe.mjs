import { parentPort } from "node:worker_threads";

parentPort?.postMessage({ kind: "tack-runtime-capability-probe", protocol: 1, runtime: "node" });
setInterval(() => undefined, 60_000);
