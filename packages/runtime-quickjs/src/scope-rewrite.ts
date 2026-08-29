import { parse } from "acorn";
import type {
  BlockStatement,
  ClassDeclaration,
  FunctionDeclaration,
  Node,
  Pattern,
  Program,
  VariableDeclaration
} from "estree";
import { transform } from "esbuild";

export interface ScopeRewriteResult {
  /** Rewritten JS to feed to `renderCodeModeUserFunctionSource` in session mode. */
  readonly code: string;
  /** Names this cell binds at the top level (added to the session's scope on success). */
  readonly declaredNames: readonly string[];
}

const WRAP_HEAD = "async function __cell() {\n";
const WRAP_TAIL = "\n}";

/**
 * Rewrite one session cell so its top-level `const`/`let`/`var`/`function`/`class`
 * declarations persist: each bound name is mirrored to `__scope[name]` right after
 * it is declared, and every name from earlier cells (`priorNames`) is re-exposed
 * as a bare `let` so this cell can read it.
 *
 * The cell is wrapped in a function before esbuild strips types, so a cell may use
 * top-level `await` and `return`; the wrapper is discarded afterward.
 */
export async function rewriteCellScope(
  cellTs: string,
  priorNames: ReadonlySet<string>
): Promise<ScopeRewriteResult> {
  const wrapped = (
    await transform(`${WRAP_HEAD}${cellTs}${WRAP_TAIL}`, { loader: "ts", format: "esm" })
  ).code;

  const program = parse(wrapped, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true
  }) as unknown as Program;

  const block = cellBlock(program);
  const bodyStart = nodeStart(block) + 1;
  const bodyEnd = nodeEnd(block) - 1;

  const declaredNames = new Set<string>();
  const inserts: { readonly at: number; readonly text: string }[] = [];

  for (const node of block.body) {
    const names = topLevelBindingNames(node);
    if (names.length === 0) {
      continue;
    }
    for (const name of names) {
      declaredNames.add(name);
    }
    inserts.push({
      at: nodeEnd(node) - bodyStart,
      text: names.map((name) => ` __scope[${JSON.stringify(name)}] = ${name};`).join("")
    });
  }

  let body = wrapped.slice(bodyStart, bodyEnd);
  for (const insert of [...inserts].sort((a, b) => b.at - a.at)) {
    body = body.slice(0, insert.at) + insert.text + body.slice(insert.at);
  }

  const reExpose = [...priorNames].filter((name) => !declaredNames.has(name));
  const prelude = reExpose.length > 0 ? `let { ${reExpose.join(", ")} } = __scope;\n` : "";

  // Mirror every in-scope name back to `__scope` at the end of the cell so a
  // reassignment (`count++`) persists to the next cell. Guarded so a name still
  // in its TDZ can't mask an error. Runs only if the cell finishes normally —
  // a cell that `return`s or `throw`s does not persist its reassignments.
  const mirrored = [...reExpose, ...declaredNames];
  const trailer =
    mirrored.length > 0
      ? "\n" +
        mirrored
          .map((name) => `try { __scope[${JSON.stringify(name)}] = ${name}; } catch {}`)
          .join(" ")
      : "";

  return { code: prelude + body + trailer, declaredNames: [...declaredNames] };
}

function cellBlock(program: Program): BlockStatement {
  const fn = program.body.find(
    (node): node is FunctionDeclaration =>
      node.type === "FunctionDeclaration" && node.id?.name === "__cell"
  );
  if (!fn) {
    throw new Error("scope rewrite: wrapper function not found");
  }
  return fn.body;
}

function nodeStart(node: Node): number {
  return (node as { start?: number }).start ?? 0;
}

function nodeEnd(node: Node): number {
  return (node as { end?: number }).end ?? 0;
}

function topLevelBindingNames(node: Node): string[] {
  if (node.type === "VariableDeclaration") {
    return (node as VariableDeclaration).declarations.flatMap((declarator) =>
      patternNames(declarator.id)
    );
  }
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    const id = (node as FunctionDeclaration | ClassDeclaration).id;
    return id ? [id.name] : [];
  }
  return [];
}

function patternNames(pattern: Pattern): string[] {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property) =>
        property.type === "RestElement"
          ? patternNames(property.argument)
          : patternNames(property.value)
      );
    case "ArrayPattern":
      return pattern.elements.flatMap((element) =>
        element === null ? [] : patternNames(element)
      );
    case "AssignmentPattern":
      return patternNames(pattern.left);
    case "RestElement":
      return patternNames(pattern.argument);
    default:
      return [];
  }
}
