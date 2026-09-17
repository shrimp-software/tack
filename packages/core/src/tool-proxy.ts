const reservedToolProxySegments = new Set([
  "then", "toJSON", "prototype", "arguments", "caller",
  ...Object.getOwnPropertyNames(Object.prototype),
  ...Object.getOwnPropertyNames(Function.prototype)
]);

/** Reflection-sensitive paths remain available through explicit SDK call(). */
export function isSafeToolProxySegment(segment: string): boolean {
  return !reservedToolProxySegments.has(segment);
}
