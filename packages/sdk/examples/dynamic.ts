import { Tack, TackError } from "@cbxss/tack-sdk";

const tack = new Tack({ configPath: "./tack.config.json" });
try {
  const result = await tack.tools.local.echo({ message: "Hello from Tack" });
  console.log(result.data); // unknown until narrowed, or use generated types
} catch (error) {
  if (!(error instanceof TackError)) throw error;
  console.error(error.code, error.path, error.upstreamOutcome);
  process.exitCode = 1;
} finally {
  await tack.close();
}
