import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  TackGeneratorError,
  ownField,
  sanitizeData,
  type TackManifest
} from "@cbxss/tack-core";

import { renderDocs } from "./docs-render.js";
import { writeSdkFiles } from "./files.js";
import { assertSupportedManifest } from "./manifest-checks.js";
import { groupMethodsByServer, plannedOperations, toGeneratedMethods } from "./methods.js";
import { renderSdkFiles } from "./sdk-render.js";
import { writeProjectTypes } from "./project-types.js";

export interface GenerateProjectTypesOptions {
  readonly manifest: TackManifest;
  /** Working directory used by scripts and containing their tsconfig. */
  readonly projectDir: string;
  /** Absolute or project-relative config path; must reside in the project. */
  readonly configPath: string;
}

/** Returns the declaration path to include in the project's TypeScript files. */
export function generateProjectTypesPromise(options: GenerateProjectTypesOptions): Promise<string> {
  return wrapGeneratorError("Failed to generate Tack project types", async () => {
    const manifest = sanitizeData(ownField(options, "manifest"), {}) as TackManifest;
    assertSupportedManifest(manifest);
    return writeProjectTypes(manifest, ownField<string>(options, "projectDir") ?? ".", ownField<string>(options, "configPath") ?? "tack.config.json");
  });
}

export interface GenerateSdkOptions {
  readonly manifest: TackManifest;
  readonly outDir: string;
}

export interface GenerateDocsOptions {
  readonly manifest: TackManifest;
  readonly outFile: string;
  readonly title?: string | undefined;
}

export function generateSdkPromise(options: GenerateSdkOptions): Promise<void> {
  return wrapGeneratorError("Failed to generate Tack SDK", async () => {
    const manifest = sanitizeData(ownField(options, "manifest"), {}) as TackManifest;
    const outDir = ownField<string>(options, "outDir") ?? "";
    assertSupportedManifest(manifest);

    const methods = toGeneratedMethods(plannedOperations(manifest));
    const methodsByServer = groupMethodsByServer(methods);
    await writeSdkFiles(outDir, await renderSdkFiles(manifest, methods, methodsByServer));
  });
}

export function generateDocsPromise(options: GenerateDocsOptions): Promise<void> {
  return wrapGeneratorError("Failed to generate Tack docs", async () => {
    const manifest = sanitizeData(ownField(options, "manifest"), {}) as TackManifest;
    const outFile = ownField<string>(options, "outFile") ?? "";
    const title = ownField<string>(options, "title");
    assertSupportedManifest(manifest);

    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, await renderDocs({ manifest, title }), "utf8");
  });
}

async function wrapGeneratorError<T>(message: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    const suffix = cause instanceof Error ? `: ${cause.message}` : "";
    throw new TackGeneratorError({ message: `${message}${suffix}`, cause });
  }
}
