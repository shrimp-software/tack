import { describe, expect, it } from "vitest";

import {
  formatCliError,
  normalizeCliErrorText,
  sanitizeCliOutputText
} from "../src/cli-output.js";

describe("CLI output helpers", () => {
  it("normalizes stack-heavy error text", () => {
    const normalized = normalizeCliErrorText(`Error: Error: TypeError: bad
      at fn1 (/tmp/a.ts:1:1)
      at fn2 (/tmp/b.ts:2:2)
From previous event:
      at fn3 (/tmp/c.ts:3:3)`);

    expect(normalized).toBe("TypeError: bad");
  });

  it("strips terminal control sequences", () => {
    expect(sanitizeCliOutputText("\u001b[31mred\u001b[0m\u0007")).toBe("red");
  });

  it("formats unknown failures without dumping object internals", () => {
    expect(formatCliError({ message: "\u001b[31mError: bad\u001b[0m" })).toBe("bad");
  });
});
