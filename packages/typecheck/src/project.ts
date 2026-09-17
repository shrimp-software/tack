import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript-5";

/** Include a declaration without replacing compiler options, comments, or inherited source globs. */
export async function includeProjectDeclaration(tsconfigPath: string, declarationPath: string): Promise<void> {
  const path = resolve(tsconfigPath);
  const directory = dirname(path);
  const declaration = relative(directory, resolve(declarationPath)).split(sep).join("/");
  let text: string;
  try {
    const status = await lstat(path);
    if (!status.isFile()) throw new Error(`Refusing to edit non-file or symlinked tsconfig: ${path}`);
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (typeof cause !== "object" || cause === null || !("code" in cause) || cause.code !== "ENOENT") throw cause;
    await mkdir(directory, { recursive: true });
    await writeFile(path, JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, lib: ["ES2022", "ESNext.Disposable"], types: ["node"] },
      include: ["**/*"], exclude: ["node_modules", ".tack/generated"], files: [declaration]
    }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    return;
  }
  const source = ts.parseJsonText(path, text);
  if (ts.parseConfigFileTextToJson(path, text).error) throw new Error(`Invalid tsconfig JSON: ${path}`);
  const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); }
  });
  // Missing listed source files / empty globs do not prevent project setup.
  const errors = parsed?.errors.filter(error => ![18002, 18003].includes(error.code)) ?? [];
  if (!parsed || errors.length) throw new Error(`Cannot update tsconfig ${path}: ${errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; ")}`);
  if (parsed.projectReferences?.length && parsed.raw.files?.length === 0 && !parsed.raw.include?.length) {
    throw new Error(`Choose the tsconfig that owns your scripts, not a references-only project: ${path}`);
  }
  const expression = source.statements[0];
  if (!expression || !ts.isExpressionStatement(expression) || !ts.isObjectLiteralExpression(expression.expression)) {
    throw new Error(`tsconfig must contain an object: ${path}`);
  }
  const object = expression.expression;
  const fileProperties = object.properties.filter(property => ts.isPropertyAssignment(property) && property.name && ts.isStringLiteral(property.name) && property.name.text === "files");
  if (fileProperties.length > 1) throw new Error(`Duplicate files entries in tsconfig: ${path}`);
  const files = fileProperties[0];
  const inheritedFiles: string[] = parsed.raw.files ?? [];
  if (inheritedFiles.some(file => resolve(directory, file) === resolve(declarationPath))) return;
  if (files && ts.isPropertyAssignment(files) && ts.isArrayLiteralExpression(files.initializer)) {
    const array = files.initializer;
    const prefix = array.elements.length && !array.elements.hasTrailingComma ? "," : "";
    const position = array.end - 1;
    text = text.slice(0, position) + `\n${prefix}${JSON.stringify(declaration)}\n` + text.slice(position);
  } else {
    const properties = [];
    // Adding files would otherwise disable TypeScript's implicit **/* inclusion.
    if (parsed.raw.files === undefined && parsed.raw.include === undefined) properties.push('"include": ["**/*"]');
    properties.push(`"files": ${JSON.stringify([...inheritedFiles, declaration])}`);
    const prefix = object.properties.length && !object.properties.hasTrailingComma ? "," : "";
    const position = object.end - 1;
    text = text.slice(0, position) + `\n${prefix}${properties.join(",\n")}\n` + text.slice(position);
  }
  // No recovery rewrite: if another process changed the config, leave it alone.
  if (await readFile(path, "utf8") !== source.text || !(await lstat(path)).isFile()) throw new Error(`tsconfig changed during SDK setup: ${path}`);
  await writeFile(path, text, "utf8");
}
