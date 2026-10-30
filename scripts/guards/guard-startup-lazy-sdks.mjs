#!/usr/bin/env node
// Static wall guard: heavy SDKs are imported where they are used, never at module scope.
// Worker startup CPU is capped (Cloudflare error 10021); evaluating a package's module body
// during startup is paid on every cold start, by every request, whether or not the feature runs.
// Type-only imports are erased by the bundler and are allowed.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const NAME = "guard-startup-lazy-sdks";
export const DISPOSITION = "block";

const LAZY_ONLY = ["@cloudflare/playwright", "docx", "pdf-lib"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (entry.isFile() && SOURCE.test(entry.name)) {
      yield full;
    }
  }
}

const packagePattern = LAZY_ONLY.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|");
const SPECIFIER = `['"](?:${packagePattern})(?:/[^'"]*)?['"]`;
const STATIC_IMPORT = new RegExp(`\\b(import|export)\\s+(type\\s+)?([^;'"]*?)\\s*from\\s*(${SPECIFIER})`, "g");
const BARE_IMPORT = new RegExp(`\\bimport\\s*(${SPECIFIER})`, "g");
const REQUIRE_CALL = new RegExp(`\\brequire\\(\\s*(${SPECIFIER})\\s*\\)`, "g");

// `import { type A, type B } from 'x'` is erased like `import type`; any other specifier is a value.
const onlyTypes = (clause) => {
  const names = clause.replace(/[{}*]/g, "").split(",").map((part) => part.trim()).filter(Boolean);
  return clause.includes("{") && !/^\s*[\w$]+\s*,/.test(clause) && names.length > 0 && names.every((part) => /^type\s/.test(part));
};

function findingsIn(file) {
  const text = readFileSync(file, "utf8");
  const found = [];
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  const report = (index, specifier) =>
    found.push(`${relative(process.cwd(), file)}:${lineOf(index)}: static import of ${specifier}; use await import(${specifier}) inside the function that needs it`);
  for (const match of text.matchAll(STATIC_IMPORT)) {
    if (match[2] || onlyTypes(match[3])) continue;
    report(match.index, match[4]);
  }
  for (const match of text.matchAll(BARE_IMPORT)) report(match.index, match[1]);
  for (const match of text.matchAll(REQUIRE_CALL)) report(match.index, match[1]);
  return found;
}

const flag = process.argv.indexOf("--root");
const roots = flag === -1 ? ["packages/runtime/src"] : [process.argv[flag + 1]];
if (roots[0] === undefined) {
  process.stderr.write(`${NAME}: --root requires a directory argument\n`);
  process.exit(2);
}

const findings = roots.flatMap((root) => [...walk(root)].flatMap(findingsIn));
if (findings.length > 0) {
  for (const line of findings) process.stderr.write(`${NAME}: ${line}\n`);
  process.exit(DISPOSITION === "warn" ? 0 : 1);
}

process.stdout.write(`${NAME}: ok\n`);
process.exit(0);
