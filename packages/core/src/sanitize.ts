export interface SanitizeOptions {
  /**
   * Message for the `Error` thrown when a reference cycle is reached. Omit to
   * instead break the cycle silently (the back-reference is dropped) — right for
   * discovery / result / schema data, where a self-referential blob is odd but
   * not fatal.
   */
  readonly onCycle?: string;
  /**
   * How to treat values that have no JSON data form (bigint / function /
   * symbol). `"throw"` (default) rejects them; `"stringify"` coerces to a
   * string (bigint → decimal, others → `String(value)`) for code-mode JSON.
   */
  readonly nonData?: "throw" | "stringify";
}

/**
 * Deep copy of `value` keeping only own, enumerable *data* properties — never a
 * getter/setter, never an inherited property.
 *
 * Objects become null-prototype and keys are assigned with
 * `Object.defineProperty`, so a literal `__proto__` key round-trips as ordinary
 * data instead of mutating a prototype. Arrays are compacted: getter,
 * non-enumerable, and hole slots are dropped, the rest keep their order. Own
 * object keys whose sanitized value is `undefined` are dropped. Primitives pass
 * through. Throws `options.onCycle` on a reference cycle.
 *
 * This is the single trust boundary: call it once where untrusted structured
 * data enters (config file, MCP response, tool args, HTTP body, VM value, option
 * bag), then work with plain typed field access downstream. For pulling a lone
 * function / callback / opaque reference off an object without firing a getter,
 * use {@link ownField} instead — that value must not be deep-copied.
 */
export function sanitizeData(value: unknown, options: SanitizeOptions): unknown {
  return sanitize(value, options, new WeakSet<object>());
}

function sanitize(value: unknown, options: SanitizeOptions, seen: WeakSet<object>): unknown {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "undefined":
      return value;
    case "bigint":
      return options.nonData === "stringify" ? value.toString() : nonDataError("bigint");
    case "function":
    case "symbol":
      return options.nonData === "stringify" ? String(value) : nonDataError(typeof value);
  }

  const object = value as object;
  if (seen.has(object)) {
    if (options.onCycle !== undefined) {
      throw new Error(options.onCycle);
    }
    return undefined;
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const out: unknown[] = [];
      for (let index = 0; index < object.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(object, index);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          continue;
        }
        out.push(sanitize(descriptor.value, options, seen));
      }
      return out;
    }

    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(object))) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        continue;
      }
      const next = sanitize(descriptor.value, options, seen);
      if (next === undefined) {
        continue;
      }
      Object.defineProperty(out, key, {
        value: next,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

function nonDataError(kind: string): never {
  throw new Error(`Tack cannot sanitize a ${kind} value`);
}

/**
 * {@link sanitizeData} narrowed to a plain record: a non-object (or array)
 * input yields an empty null-prototype object. For sanitizing loose
 * `Record<string, unknown>` inputs like tool-call arguments.
 */
export function sanitizeRecord(
  value: unknown,
  options: SanitizeOptions = {}
): Record<string, unknown> {
  const clean = sanitizeData(value, options);
  return typeof clean === "object" && clean !== null && !Array.isArray(clean)
    ? (clean as Record<string, unknown>)
    : (Object.create(null) as Record<string, unknown>);
}

/**
 * Read one own, enumerable-or-not *data* property off `object` — `undefined` if
 * it is absent, inherited, or an accessor (the getter is never invoked).
 *
 * For structured data use {@link sanitizeData}; `ownField` is for the few places
 * that must grab a function / callback / opaque reference from a caller-supplied
 * object without triggering a getter and without deep-copying the value.
 */
export function ownField<T = unknown>(object: unknown, key: PropertyKey): T | undefined {
  if (typeof object !== "object" || object === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? (descriptor.value as T) : undefined;
}
