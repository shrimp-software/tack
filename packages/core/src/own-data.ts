export function ownDataValue<T = unknown>(object: object | undefined, key: PropertyKey): T | undefined {
  const descriptor = object ? Object.getOwnPropertyDescriptor(object, key) : undefined;
  return descriptor && "value" in descriptor ? descriptor.value as T : undefined;
}

export function ownDataEntries<T = unknown>(object: object | undefined): Array<[string, T]> {
  return object
    ? Object.entries(Object.getOwnPropertyDescriptors(object)).flatMap(([key, descriptor]) =>
        descriptor.enumerable && "value" in descriptor
          ? [[key, descriptor.value as T] as [string, T]]
          : []
      )
    : [];
}

export function ownDataValues<T = unknown>(object: object | undefined): T[] {
  return object
    ? Object.values(Object.getOwnPropertyDescriptors(object)).flatMap((descriptor) =>
        descriptor.enumerable && "value" in descriptor ? [descriptor.value as T] : []
      )
    : [];
}

export function ownDataRecord(value: unknown): Record<string, unknown> {
  const record = Object.create(null) as Record<string, unknown>;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return record;
  }

  for (const [key, entryValue] of ownDataEntries(value)) {
    record[key] = entryValue;
  }
  return record;
}
