import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  TackGeneratorError,
  ownField,
  sanitizeData,
  type TackManifest
} from "@tack/core";

import { renderDocs } from "./docs-render.js";
import { writeSdkFiles } from "./files.js";
import { assertSupportedManifest } from "./manifest-checks.js";
import { groupMethodsByServer, plannedOperations, toGeneratedMethods } from "./methods.js";
import { renderSdkFiles } from "./sdk-render.js";

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

async function wrapGeneratorError(message: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (cause) {
    const suffix = cause instanceof Error ? `: ${cause.message}` : "";
    throw new TackGeneratorError({ message: `${message}${suffix}`, cause });
  }
}
