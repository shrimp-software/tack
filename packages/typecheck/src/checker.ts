import { basename, dirname, join } from "node:path";

import type { TackManifest } from "@cbxss/tack-core";
import type {
  OperationPolicy,
  TypeChecker,
  TypeCheckOutcome,
  TypeDiagnostic
} from "@cbxss/tack-codemode";
import ts from "typescript-5";

import { buildAmbientDts } from "./ambient.js";

const CELL_PATH = "/__tack_cell.ts";
const AMBIENT_PATH = "/__tack_ambient.d.ts";

const COMPILER_OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts"],
  types: [],
  moduleDetection: ts.ModuleDetectionKind.Force,
  skipLibCheck: true
};

export interface CreateTypeCheckerOptions {
  readonly manifest: TackManifest;
  readonly policy?: OperationPolicy | undefined;
}

/**
 * A persistent in-process TypeScript language service that checks one code-mode
 * cell at a time against a synthesized ambient `.d.ts`. The ambient + lib files
 * are parsed once; each `check` swaps the cell's snapshot and re-checks only it
 * (~1–5ms warm, ~100–200ms for the first call). Any internal failure returns
 * `{ skipped: true }` — a checker fault never blocks execution.
 */
export function createTypeChecker(options: CreateTypeCheckerOptions): TypeChecker {
  let service: ts.LanguageService | undefined;
  let ambientText = "";
  let cellText = "";
  let cellVersion = 0;
  const libDir = dirname(ts.getDefaultLibFilePath(COMPILER_OPTIONS));

  const readFile = (fileName: string): string | undefined => {
    if (fileName === AMBIENT_PATH) return ambientText;
    if (fileName === CELL_PATH) return cellText;
    return ts.sys.readFile(toLibPath(fileName, libDir));
  };

  const initService = async (): Promise<ts.LanguageService> => {
    if (service) return service;
    ambientText = await buildAmbientDts(options.manifest, options.policy);
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [AMBIENT_PATH, CELL_PATH],
      getScriptVersion: (fileName) => (fileName === CELL_PATH ? String(cellVersion) : "1"),
      getScriptSnapshot: (fileName) => {
        const text = readFile(fileName);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => "/",
      getCompilationSettings: () => COMPILER_OPTIONS,
      getDefaultLibFileName: (o) => "/" + ts.getDefaultLibFileName(o),
      fileExists: (fileName) =>
        fileName === AMBIENT_PATH || fileName === CELL_PATH || ts.sys.fileExists(toLibPath(fileName, libDir)),
      readFile,
      readDirectory: (...args) => ts.sys.readDirectory(...args),
      getDirectories: (dir) => ts.sys.getDirectories(dir),
      directoryExists: (dir) => ts.sys.directoryExists(dir),
      useCaseSensitiveFileNames: () => true
    };
    service = ts.createLanguageService(host, ts.createDocumentRegistry());
    return service;
  };

  return {
    check: async (code: string): Promise<TypeCheckOutcome> => {
      try {
        const ls = await initService();
        // Lines before the user's first line: the wrapper's `async function …`
        // line. `getLineAndCharacterOfPosition` is 0-based.
        const offset = 1;
        cellText = `async function __tackCheckCell(): Promise<any> {\n${code}\n}\n`;
        cellVersion += 1;

        const diagnostics = [
          ...ls.getSyntacticDiagnostics(CELL_PATH),
          ...ls.getSemanticDiagnostics(CELL_PATH)
        ];
        const source = ls.getProgram()?.getSourceFile(CELL_PATH);
        if (!source) {
          return { diagnostics: [], skipped: true, skipReason: "no cell source file" };
        }

        const mapped: TypeDiagnostic[] = [];
        for (const d of diagnostics) {
          if (d.file?.fileName !== CELL_PATH || d.start === undefined) continue;
          const lc = source.getLineAndCharacterOfPosition(d.start);
          const line = lc.line - offset + 1;
          if (line < 1) continue;
          mapped.push({
            line,
            column: lc.character + 1,
            code: `TS${d.code}`,
            message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
            category: d.category === ts.DiagnosticCategory.Error ? "error" : "warning"
          });
        }
        mapped.sort((a, b) => a.line - b.line || a.column - b.column);
        return { diagnostics: mapped };
      } catch (error) {
        return {
          diagnostics: [],
          skipped: true,
          skipReason: error instanceof Error ? error.message : String(error)
        };
      }
    }
  };
}

function toLibPath(fileName: string, libDir: string): string {
  return /^\/lib\.[^/]+\.d\.ts$/.test(fileName) ? join(libDir, basename(fileName)) : fileName;
}
