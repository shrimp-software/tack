import { z } from "zod";

import { defineTool } from "../../src/index.js";

let handlerStarted: (() => void) | undefined;

export function waitForAbortHandlerStart(): Promise<void> {
  return new Promise((resolve) => {
    handlerStarted = resolve;
  });
}

function markHandlerStarted(): void {
  handlerStarted?.();
  handlerStarted = undefined;
}

export const add = defineTool({
  name: "add",
  description: "Add two numbers",
  input: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }) => ({ sum: a + b })
});

export const shout = defineTool({
  name: "shout_message",
  input: z.object({ message: z.string() }),
  handler: async ({ message }) => message.toUpperCase()
});

export const boom = defineTool({
  name: "boom",
  description: "Always throws",
  input: z.object({}),
  handler: () => {
    throw new Error("kaboom");
  }
});

export const noop = defineTool({
  name: "noop",
  description: "Returns nothing",
  handler: () => undefined
});

export const waitForAbort = defineTool({
  name: "wait_for_abort",
  handler: (_input, context) => new Promise((resolve) => {
    markHandlerStarted();
    if (context.signal?.aborted) {
      resolve({ aborted: true });
      return;
    }
    context.signal?.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
  })
});

export const rejectOnAbort = defineTool({
  name: "reject_on_abort",
  handler: (_input, context) => new Promise((_resolve, reject) => {
    markHandlerStarted();
    context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
  })
});

/** Not a tool — discovery must ignore it. */
export const answer = 42;
