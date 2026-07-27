import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  TackGeneratorError,
  ownDataValue as ownValue,
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
    const manifest = ownValue<TackManifest>(options, "manifest") as TackManifest;
    const outDir = ownValue<string>(options, "outDir") as string;
    assertSupportedManifest(manifest);

    const methods = toGeneratedMethods(plannedOperations(manifest));
    const methodsByServer = groupMethodsByServer(methods);
    await writeSdkFiles(outDir, await renderSdkFiles(manifest, methods, methodsByServer));
  });
}

export function generateDocsPromise(options: GenerateDocsOptions): Promise<void> {
  return wrapGeneratorError("Failed to generate Tack docs", async () => {
    const manifest = ownValue<TackManifest>(options, "manifest") as TackManifest;
    const outFile = ownValue<string>(options, "outFile") as string;
    const title = ownValue<string>(options, "title");
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
