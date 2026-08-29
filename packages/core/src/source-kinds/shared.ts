import { ownDataEntries, ownDataValue as ownValue, ownDataValues } from "../own-data.js";

/** Own, enumerable string entries of `object[key]` when it is an array, else `undefined`. */
export function ownStringArray(
  object: object | undefined,
  key: string
): readonly string[] | undefined {
  const value = ownValue<unknown>(object, key);
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = ownDataValues<unknown>(value).filter(
    (entry): entry is string => typeof entry === "string"
  );
  return strings.length > 0 ? strings : undefined;
}

/** Own, enumerable string-valued entries of `object[key]` when it is a plain object, else `undefined`. */
export function ownStringRecord(
  object: object | undefined,
  key: string
): Readonly<Record<string, string>> | undefined {
  const value = ownValue<unknown>(object, key);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = Object.create(null) as Record<string, string>;
  for (const [entryKey, entryValue] of ownDataEntries<unknown>(value)) {
    if (typeof entryValue === "string") {
      record[entryKey] = entryValue;
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}
