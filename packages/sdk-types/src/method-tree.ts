import { hasRequiredInput, propertyKey, type JsonSchema } from "@cbxss/tack-core";

/**
 * The minimum an operation must provide to be rendered into a method tree.
 * `@cbxss/tack-generator`'s `GeneratedMethod` satisfies this structurally, as does
 * the adapter `@cbxss/tack-codemode` builds for the ambient `tools` surface.
 */
export interface MethodLike {
  readonly namespaceName: string;
  readonly path: readonly string[];
  readonly inputType: string;
  readonly outputType: string;
  readonly resultType: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema | undefined;
  readonly description?: string | undefined;
  readonly examples: readonly string[];
  readonly injectedArgs?: Readonly<Record<string, string>> | undefined;
}

export interface MethodTree<M extends MethodLike = MethodLike> {
  readonly children: Map<string, MethodTree<M>>;
  method?: M;
}

/**
 * Fold operations into a nested tree keyed by path segment. Throws if two
 * operations' inferred paths overlap (one nests under another, or one is a
 * prefix of another) — `listOperations`' `uniquePath` already prevents this for
 * a real manifest.
 */
export function buildMethodTree<M extends MethodLike>(methods: readonly M[]): MethodTree<M> {
  const root: MethodTree<M> = { children: new Map() };

  for (const method of methods) {
    let node: MethodTree<M> = root;
    const parentPath: string[] = [];
    for (const segment of method.path) {
      if (node.method) {
        throw new Error(
          `Generated SDK path ${method.namespaceName}.${method.path.join(".")} nests under ` +
          `${method.namespaceName}.${parentPath.join(".")}. Inferred operation paths must not overlap.`
        );
      }

      const child = node.children.get(segment) ?? { children: new Map() };
      node.children.set(segment, child);
      node = child;
      parentPath.push(segment);
    }

    if (node.children.size > 0) {
      throw new Error(
        `Generated SDK path ${method.namespaceName}.${method.path.join(".")} is a prefix of another operation. ` +
        "Inferred operation paths must not overlap."
      );
    }
    node.method = method;
  }

  return root;
}

export interface RenderInterfaceTreeOptions<M extends MethodLike> {
  /** The leaf method's return type, e.g. `m => m.resultType` or `` m => `CodeModeResult<${m.outputType}>` ``. */
  readonly result: (method: M) => string;
}

/** Render a method tree as the body lines of a TypeScript object/interface type. */
export function renderInterfaceTree<M extends MethodLike>(
  tree: MethodTree<M>,
  indent: string,
  options: RenderInterfaceTreeOptions<M>
): string[] {
  return [...tree.children.entries()].flatMap(([name, child]) => {
    if (child.method) {
      return [
        ...renderJsDoc(child.method.description, child.method.examples, indent),
        `${indent}${propertyKey(name)}(${argSignature(child.method)}): Promise<${options.result(child.method)}>;`
      ];
    }

    return [
      `${indent}readonly ${propertyKey(name)}: {`,
      ...renderInterfaceTree(child, `${indent}  `, options),
      `${indent}};`
    ];
  });
}

export function argSignature(method: MethodLike): string {
  return `${hasRequiredInput(method.inputSchema) ? "args" : "args?"}: ${method.inputType}`;
}

export function renderJsDoc(
  description: string | undefined,
  examples: readonly string[],
  indent: string
): string[] {
  if (!description && examples.length === 0) {
    return [];
  }

  const lines = [
    ...(description ? jsDocTextLines(description, true) : []),
    ...(description && examples.length > 0 ? [""] : []),
    ...examples.flatMap((example) => ["@example", ...jsDocTextLines(example, true)])
  ];
  return [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`), `${indent} */`];
}

export function jsDocTextLines(value: string, escapeTags: boolean): string[] {
  return value
    .replaceAll("*/", "* /")
    .split(/\r\n|\r|\n/)
    .map((line) => (escapeTags && /^\s*@/u.test(line) ? line.replace("@", "\\@") : line));
}
