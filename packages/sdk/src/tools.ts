import { isSafeToolProxySegment } from "@cbxss/tack-core";
import type { DynamicTool, DynamicTools, TackArgs, TackCallOptions, TackResponse } from "./types.js";

/** Only an explicit function call dispatches; reflection never discovers tools. */
export function createTools(invoke: (path: string, args?: TackArgs, options?: TackCallOptions) => Promise<TackResponse>): DynamicTools {
  function node(segments: readonly string[]): DynamicTool {
    const children = new Map<string, DynamicTool>();
    const target = (args?: TackArgs, options?: TackCallOptions) => invoke(segments.join("."), args, options);
    // No prototype or non-configurable callable properties to leak into paths.
    Reflect.deleteProperty(target, "name");
    Reflect.deleteProperty(target, "length");
    Object.setPrototypeOf(target, null);
    Object.freeze(target);
    return new Proxy(target, {
      get(_target, key) {
        if (key === Symbol.toPrimitive) return () => `[Tack tools${segments.length ? `.${segments.join(".")}` : ""}]`;
        if (typeof key !== "string" || !isSafeToolProxySegment(key)) return undefined;
        let child = children.get(key);
        if (!child) { child = node([...segments, key]); children.set(key, child); }
        return child;
      }
    }) as DynamicTool;
  }
  return node([]);
}
