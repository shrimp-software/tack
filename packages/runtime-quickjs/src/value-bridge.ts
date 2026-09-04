import type { QuickJSAsyncContext, QuickJSHandle } from "quickjs-emscripten";

export function drainPendingJobs(context: QuickJSAsyncContext): void {
  while (context.runtime.hasPendingJob()) {
    context.runtime.executePendingJobs().dispose();
  }
}

export function disposeHandle(handle: QuickJSHandle | undefined): void {
  if (handle?.alive) {
    handle.dispose();
  }
}

export function snapshotQuickJSValue(context: QuickJSAsyncContext, handle: QuickJSHandle): unknown {
  return snapshotJsonData(context.dump(handle));
}

function snapshotJsonData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "bigint") {
    throw new Error("BigInt values are not supported in Tack code-mode JSON data");
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    throw new Error("Cyclic JSON data is not supported in Tack code-mode");
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const snapshot = snapshotJsonData(item, seen);
        return snapshot === undefined ? null : snapshot;
      });
    }

    const output: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        continue;
      }

      const snapshot = snapshotJsonData(descriptor.value, seen);
      if (snapshot !== undefined) {
        output[key] = snapshot;
      }
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function toQuickJSJsonValue(context: QuickJSAsyncContext, value: unknown): QuickJSHandle {
  const snapshot = snapshotJsonData(value);
  if (snapshot === undefined) {
    return context.undefined;
  }
  if (snapshot === null) {
    return context.null;
  }
  if (typeof snapshot === "string") {
    return context.newString(snapshot);
  }
  if (typeof snapshot === "number") {
    return context.newNumber(snapshot);
  }
  if (typeof snapshot === "boolean") {
    return snapshot ? context.true : context.false;
  }
  if (Array.isArray(snapshot)) {
    const arrayHandle = context.newArray();
    for (let index = 0; index < snapshot.length; index += 1) {
      const itemHandle = toQuickJSJsonValue(context, snapshot[index]);
      context.setProp(arrayHandle, index, itemHandle);
      disposeHandle(itemHandle);
    }
    return arrayHandle;
  }

  const objectHandle = context.newObject();
  for (const [key, item] of Object.entries(snapshot as Record<string, unknown>)) {
    const itemHandle = toQuickJSJsonValue(context, item);
    context.defineProp(objectHandle, key, {
      value: itemHandle,
      enumerable: true,
      configurable: true
    });
    disposeHandle(itemHandle);
  }
  return objectHandle;
}
