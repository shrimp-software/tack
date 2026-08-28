import { z } from "zod";

import { defineTool } from "../../src/index.js";

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

/** Not a tool — discovery must ignore it. */
export const answer = 42;
