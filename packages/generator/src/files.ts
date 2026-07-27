import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GENERATED_FILE_HEADER, type GeneratedFile } from "./types.js";

export async function writeSdkFiles(outDir: string, files: readonly GeneratedFile[]): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await assertReplaceableFileTargets(outDir, files);

  const stageDir = await mkdtemp(join(outDir, ".tack-sdk-"));
  try {
    await Promise.all(files.map((file) =>
      writeGeneratedFile(stageDir, file.fileName, file.contents)
    ));
    await cleanGeneratedTsFiles(outDir);
    await Promise.all(files.map((file) =>
      rename(join(stageDir, file.fileName), join(outDir, file.fileName))
    ));
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

async function writeGeneratedFile(
  outDir: string,
  fileName: string,
  contents: string
): Promise<void> {
  await writeFile(join(outDir, fileName), contents, "utf8");
}

async function assertReplaceableFileTargets(
  outDir: string,
  files: readonly GeneratedFile[]
): Promise<void> {
  await Promise.all(files.map(async (file) => {
    const path = join(outDir, file.fileName);
    const target = await existingFileStatus(path);
    if (!target) {
      return;
    }

    if (target && !target.isFile()) {
      throw new Error(`Cannot write generated SDK file ${file.fileName}: target path is not a file`);
    }

    const contents = await readFile(path, "utf8");
    if (!contents.startsWith(GENERATED_FILE_HEADER)) {
      throw new Error(`Refusing to overwrite non-generated SDK file ${file.fileName}`);
    }
  }));
}

async function existingFileStatus(path: string) {
  try {
    return await stat(path);
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return undefined;
    }
    throw cause;
  }
}

async function cleanGeneratedTsFiles(outDir: string): Promise<void> {
  const entries = await readdir(outDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map(async (entry) => {
      const path = join(outDir, entry.name);
      const contents = await readFile(path, "utf8").catch(() => "");
      if (contents.startsWith(GENERATED_FILE_HEADER)) {
        await rm(path, { force: true });
      }
    }));
}
