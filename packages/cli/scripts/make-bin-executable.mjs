import { chmod } from "node:fs/promises";
import { join } from "node:path";

await chmod(join(import.meta.dirname, "..", "dist", "index.js"), 0o755);
