import { stat } from "node:fs/promises";
import { DEFAULT_CONFIG_PATH, loadConfigPromise, type TackConfig } from "@tack/core";
import { discoverManifest } from "@tack/sources";
import { formatCliError } from "./cli-output.js";

export interface DoctorOptions {
  readonly config: string;
  readonly discovery: boolean;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const lines: string[] = [];
  let ok = true;

  lines.push(checkLine("ok", `Bun ${bunVersion()}`));

  if (!(await exists(options.config))) {
    return {
      ok: false,
      lines: [
        ...lines,
        checkLine("fail", `Config not found at ${options.config}`),
        `Run \`tack init${options.config === DEFAULT_CONFIG_PATH ? "" : ` --config ${options.config}`}\` to create one.`
      ]
    };
  }

  lines.push(checkLine("ok", `Found config at ${options.config}`));

  let config: TackConfig;
  try {
    config = await loadConfigPromise(options.config);
    lines.push(checkLine("ok", `Parsed ${Object.keys(config.servers).length} source config(s)`));
  } catch (error) {
    return {
      ok: false,
      lines: [
        ...lines,
        checkLine("fail", "Config is invalid"),
        formatCliError(error)
      ]
    };
  }

  if (!options.discovery) {
    return {
      ok,
      lines: [...lines, checkLine("warn", "Skipped live source discovery")]
    };
  }

  try {
    const manifest = await discoverManifest(config);
    lines.push(checkLine("ok", `Discovered ${Object.keys(manifest.tools).length} tool(s)`));
  } catch (error) {
    ok = false;
    lines.push(checkLine("fail", "Source discovery failed"));
    lines.push(formatCliError(error));
  }

  return { ok, lines };
}

function bunVersion(): string {
  return process.versions.bun ?? "not detected";
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function checkLine(status: "ok" | "warn" | "fail", message: string): string {
  return `[${status}] ${message}`;
}
