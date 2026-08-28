/**
 * Example module source: serve a directory of markdown files as two tools.
 *
 * In your own project this import is `from "@tack/sources"`; it is relative here
 * only because the file lives inside the package.
 *
 * Point a config entry at it:
 *
 * ```jsonc
 * { "servers": { "docs": { "transport": "module", "entry": "./markdown-source.ts" } } }
 * ```
 *
 * The docs directory defaults to `./docs` next to this file; override it with the
 * `TACK_DOCS_DIR` environment variable.
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { defineTool } from "../src/index.js";

const DOCS_DIR = process.env["TACK_DOCS_DIR"]
  ? resolve(process.env["TACK_DOCS_DIR"])
  : fileURLToPath(new URL("./docs/", import.meta.url));

const SLUG = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be kebab-case (no path separators)");

export const listDocs = defineTool({
  name: "list",
  description: "List every markdown document, with its title.",
  async handler() {
    const slugs = await readMarkdownSlugs();
    return Promise.all(
      slugs.map(async (slug) => ({ slug, title: titleOf(await readMarkdown(slug), slug) }))
    );
  }
});

export const readDoc = defineTool({
  name: "read",
  description: "Read one markdown document by slug.",
  input: z.object({ slug: SLUG }),
  async handler({ slug }) {
    const markdown = await readMarkdown(slug);
    return { slug, title: titleOf(markdown, slug), markdown };
  }
});

async function readMarkdownSlugs(): Promise<string[]> {
  const entries = await readdir(DOCS_DIR);
  return entries
    .filter((entry) => extname(entry) === ".md")
    .map((entry) => basename(entry, ".md"))
    .sort();
}

async function readMarkdown(slug: string): Promise<string> {
  try {
    return await readFile(join(DOCS_DIR, `${slug}.md`), "utf8");
  } catch {
    throw new Error(`No document named "${slug}"`);
  }
}

function titleOf(markdown: string, fallback: string): string {
  const heading = markdown.split("\n").find((line) => line.startsWith("# "));
  return heading ? heading.slice(2).trim() : fallback;
}
