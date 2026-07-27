interface TackErrorFields {
  readonly message: string;
  readonly cause?: unknown;
}

export class TackConfigError extends Error {
  readonly _tag = "TackConfigError";
  readonly cause?: unknown;

  constructor(args: TackErrorFields) {
    super(readOwnString(args, "message") ?? "");
    this.name = "TackConfigError";
    const cause = readOwnData(args, "cause");
    if (cause.found) {
      this.cause = cause.value;
    }
  }
}

export class TackIoError extends Error {
  readonly _tag = "TackIoError";
  readonly path?: string;
  readonly cause?: unknown;

  constructor(args: TackErrorFields & { readonly path?: string }) {
    super(readOwnString(args, "message") ?? "");
    this.name = "TackIoError";
    const path = readOwnData(args, "path");
    if (path.found && typeof path.value === "string") {
      this.path = path.value;
    }
    const cause = readOwnData(args, "cause");
    if (cause.found) {
      this.cause = cause.value;
    }
  }
}

export class TackRuntimeError extends Error {
  readonly _tag = "TackRuntimeError";
  readonly toolId?: string;
  readonly serverId?: string;
  readonly cause?: unknown;

  constructor(args: TackErrorFields & {
    readonly toolId?: string;
    readonly serverId?: string;
  }) {
    super(readOwnString(args, "message") ?? "");
    this.name = "TackRuntimeError";
    const toolId = readOwnData(args, "toolId");
    if (toolId.found && typeof toolId.value === "string") {
      this.toolId = toolId.value;
    }
    const serverId = readOwnData(args, "serverId");
    if (serverId.found && typeof serverId.value === "string") {
      this.serverId = serverId.value;
    }
    const cause = readOwnData(args, "cause");
    if (cause.found) {
      this.cause = cause.value;
    }
  }
}

export class TackGeneratorError extends Error {
  readonly _tag = "TackGeneratorError";
  readonly cause?: unknown;

  constructor(args: TackErrorFields) {
    super(readOwnString(args, "message") ?? "");
    this.name = "TackGeneratorError";
    const cause = readOwnData(args, "cause");
    if (cause.found) {
      this.cause = cause.value;
    }
  }
}

export type TackError =
  | TackConfigError
  | TackIoError
  | TackRuntimeError
  | TackGeneratorError;

export function formatTackError(error: unknown): string {
  const message = readOwnData(error, "message");
  if (message.found) {
    return withCauseMessage(String(message.value), error);
  }

  if (error instanceof Error) {
    return readOwnString(error, "name") ?? "Error";
  }

  if (typeof error === "object" && error !== null) {
    return "[object Object]";
  }

  return String(error);
}

function withCauseMessage(message: string, error: unknown): string {
  const cause = readOwnData(error, "cause");
  if (!cause.found) {
    return message;
  }

  const causeMessage = readOwnData(cause.value, "message");
  if (!causeMessage.found) {
    return message;
  }

  return `${message}: ${String(causeMessage.value)}`;
}

function readOwnString(value: unknown, key: PropertyKey): string | undefined {
  const data = readOwnData(value, key);
  return data.found && typeof data.value === "string" ? data.value : undefined;
}

function readOwnData(
  value: unknown,
  key: PropertyKey
): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  if (typeof value !== "object" || value === null) {
    return { found: false };
  }

  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor
    ? { found: true, value: descriptor.value }
    : { found: false };
}
