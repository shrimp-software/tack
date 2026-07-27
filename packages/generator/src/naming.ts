export function typeSegment(identifier: string): string {
  const value = words(identifier)
    .map(capitalize)
    .join("");
  return /^[A-Z_$]/u.test(value) ? value : `_${value || "Item"}`;
}

export function propertyKey(name: string): string {
  return JSON.stringify(name);
}

export function objectLiteralKey(key: string): string {
  return key === "__proto__" ? `[${JSON.stringify(key)}]` : JSON.stringify(key);
}

function words(identifier: string): string[] {
  return identifier.match(/[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+/g) ?? [];
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
