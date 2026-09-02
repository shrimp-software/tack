export function objectLiteralKey(key: string): string {
  return key === "__proto__" ? `[${JSON.stringify(key)}]` : JSON.stringify(key);
}
