import { Tack } from "@cbxss/tack-sdk";

// Use the source fixture for native .ts/.mts, or its emitted file after compilation.
const entry = /\.m?ts$/u.test(import.meta.url) ? "./tools.ts" : "./tools.js";
const tack = new Tack({
  config: { servers: { local: { transport: "module", entry } } },
  configDir: import.meta.dirname
});
try {
  await tack.ready();
  const result = await tack.call("local.echo", { message: "Inline config" }, {
    signal: AbortSignal.timeout(5000), timeoutMs: 3000
  });
  console.log(result.data);
} finally {
  await tack.close();
}
