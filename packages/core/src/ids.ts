export function sanitizeId(value: string, fallback = "item"): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");

  return cleaned.length > 0 ? cleaned : fallback;
}

export function toIdentifier(value: string, fallback = "item"): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "");
  const parts = (cleaned.length > 0 ? cleaned : fallback).split("_");
  const [first, ...rest] = parts;
  const name = [
    lowerFirst(first ?? fallback),
    ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  ].join("");
  return /^[a-zA-Z_$]/.test(name) ? name : `_${name}`;
}

/**
 * PascalCase a raw identifier for use as a TypeScript type-name segment.
 * Splits on case boundaries, digits, and non-alphanumerics; guards a leading
 * non-identifier character with `_` so the result is always a valid TS name
 * (e.g. `"2fa"` → `"_2Fa"`, `""` → `"_Item"`). Shared by the static SDK
 * (`@tack/generator`) and code-mode type surfaces (`@tack/codemode`).
 */
export function typeSegment(identifier: string): string {
  const value = typeSegmentWords(identifier).map(capitalizeWord).join("");
  return /^[A-Z_$]/u.test(value) ? value : `_${value || "Item"}`;
}

/** Quote a property name for an object type / literal (always quoted). */
export function propertyKey(name: string): string {
  return JSON.stringify(name);
}

function typeSegmentWords(identifier: string): string[] {
  return identifier.match(/[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+/g) ?? [];
}

function capitalizeWord(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function dedupeName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  let counter = 2;
  while (used.has(`${base}${counter}`)) {
    counter += 1;
  }

  const next = `${base}${counter}`;
  used.add(next);
  return next;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
