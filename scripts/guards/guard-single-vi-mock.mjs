#!/usr/bin/env node
// Static wall guard: one vi.mock per module per test file. Vitest resolves the
// hoisted vi.mock queue in parallel and registers each factory when its resolve
// settles, so with two factories for one module the winner is whichever resolve
// finishes last, not whichever is declared last. A stale duplicate factory then
// fails the file only on some (typically cold-cache) runs.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const NAME = "guard-single-vi-mock";
export const DISPOSITION = "block";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const MOCK_CALL = /\bvi\.mock\(\s*(['"`])([^'"`]+)\1/g;

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

// Relative specifiers that differ only in spelling or extension name one module.
function moduleKey(file, specifier) {
  if (!specifier.startsWith(".")) return specifier;
  const absolute = resolve(dirname(file), specifier);
  return absolute.slice(0, absolute.length - extname(absolute).length || undefined);
}

function findingsIn(file) {
  const text = readFileSync(file, "utf8");
  if (!text.includes("vi.mock(")) return [];
  const firstLine = new Map();
  const out = [];
  for (const match of text.matchAll(MOCK_CALL)) {
    const key = moduleKey(file, match[2]);
    const line = text.slice(0, match.index).split("\n").length;
    const first = firstLine.get(key);
    if (first === undefined) firstLine.set(key, line);
    else out.push(`${relative(process.cwd(), file)}:${line}: second vi.mock('${match[2]}') (first at line ${first}); the winning factory is order-dependent`);
  }
  return out;
}

const flag = process.argv.indexOf("--root");
const roots = flag === -1 ? ["packages"] : [process.argv[flag + 1]];
if (roots[0] === undefined) {
  process.stderr.write(`${NAME}: --root requires a directory argument\n`);
  process.exit(2);
}

const findings = roots.flatMap((root) => [...walk(root)].flatMap(findingsIn));
if (findings.length > 0) {
  for (const line of findings) process.stderr.write(`${line}\n`);
  process.exit(DISPOSITION === "warn" ? 0 : 1);
}

process.stdout.write(`${NAME}: ok\n`);
process.exit(0);
