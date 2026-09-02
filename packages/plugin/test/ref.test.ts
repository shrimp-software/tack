import { describe, expect, it } from "vitest";

import { parsePluginRef, slugForGitRef, type ParsedPluginRef } from "../src/ref.js";

function git(source: string, ref: string): Extract<ParsedPluginRef, { kind: "git" }> {
  const parsed = parsePluginRef({ source, ref }, "p");
  if (parsed.kind !== "git") {
    throw new Error("expected a git ref");
  }
  return parsed;
}

describe("parsePluginRef", () => {
  it("treats a { path } ref as local", () => {
    expect(parsePluginRef({ path: "./plugins/acme" }, "acme")).toEqual({
      kind: "local",
      path: "./plugins/acme"
    });
  });

  it("expands a github: shorthand to an https clone url", () => {
    const parsed = parsePluginRef({ source: "github:acme/tools", ref: "v1.2.0" }, "acme");
    expect(parsed).toMatchObject({
      kind: "git",
      cloneUrl: "https://github.com/acme/tools.git",
      source: "github:acme/tools",
      ref: "v1.2.0"
    });
  });

  it("keeps an https git url as-is and normalises a subdir", () => {
    const parsed = parsePluginRef(
      { source: "https://example.com/x/y.git", ref: "main", subdir: "./packages/plugin/" },
      "y"
    );
    expect(parsed).toMatchObject({
      kind: "git",
      cloneUrl: "https://example.com/x/y.git",
      subdir: "packages/plugin"
    });
  });

  it("rejects a git source with no ref", () => {
    expect(() => parsePluginRef({ source: "github:a/b", ref: "" }, "b")).toThrow(/ref/);
  });

  it("rejects an unrecognised source", () => {
    expect(() => parsePluginRef({ source: "npm:some-pkg", ref: "1.0.0" }, "p")).toThrow(/not a recognised/);
  });

  it("derives a stable, filesystem-safe slug", () => {
    const a = slugForGitRef(git("github:acme/tools", "v1"));
    const b = slugForGitRef(git("github:acme/tools", "v2"));
    expect(a).toBe(b); // slug does not depend on the ref, only the location
    expect(a).toMatch(/^[a-zA-Z0-9_.-]+$/);
  });
});
