#!/usr/bin/env node
// Static wall guard: forbids the vitest silent-skip escape hatch in tracked
// config. LOCAL-DEV-TESTING-PIPELINE.md "No silent skips" mandates that the
// default gate never runs zero tests and reports green; passWithNoTests is the
// exact mechanism that lets an empty or misfiltered suite pass, hiding the
// "done that isn't" failure mode.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";

const NAME = "guard-no-passwithnotests";
export const DISPOSITION = "block";

// This guard's own source contains the literal token; exempt exactly this file
// (by absolute path, not a whole-dir glob — a dir exemption is spoofable).
const SELF = fileURLToPath(import.meta.url);

const NEEDLE = "passWithNoTests";
const MESSAGE = "vitest silent-skip escape hatch forbidden (LOCAL-DEV-TESTING-PIPELINE.md: no silent skips)";

// Directories never worth walking: dependency trees and VCS metadata.
const SKIP_DIRS = new Set(["node_modules", ".git"]);

// The escape hatch can hide in any config surface vitest reads — vitest.config
// in any JS/TS extension, vite.config, vitest.workspace, package.json — or a CI
// yaml, or a module that re-exports config. Enumerating those names leaves scope
// holes (proven by the attack pass). Instead scan every tracked file under the
// roots for the literal token; it is distinctive enough that a whole-tree scan
// carries no realistic false positive.
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Missing or unreadable root (e.g. .github not created yet): skip, do not throw.
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function findingsIn(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (!text.includes(NEEDLE)) return [];
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(NEEDLE)) {
      out.push(`${relative(process.cwd(), file)}:${i + 1}: ${MESSAGE}`);
    }
  }
  return out;
}

// Non-recursive: a directory's own top-level files. The repo-root package.json
// (and root vite/vitest configs) live here — the likeliest place to add the
// escape hatch — and a recursive walk of packages/scripts/.github never reaches
// them because they are siblings of those dirs, not children.
function* topLevelFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isFile()) yield join(dir, entry.name);
  }
}

function resolveRoots(argv) {
  const flag = argv.indexOf("--root");
  if (flag !== -1) {
    const dir = argv[flag + 1];
    if (!dir) {
      process.stderr.write(`${NAME}: --root requires a directory argument\n`);
      process.exit(2);
    }
    // --root replaces the defaults and recurses from it (so its top-level files
    // are already covered), keeping RED proofs hermetic to the fixture.
    return { roots: [dir], rootFilesDir: null };
  }
  return { roots: ["packages", "scripts", ".github"], rootFilesDir: "." };
}

const { roots, rootFilesDir } = resolveRoots(process.argv.slice(2));
const findings = [];
if (rootFilesDir) {
  for (const file of topLevelFiles(rootFilesDir)) {
    if (resolve(file) === SELF) continue;
    findings.push(...findingsIn(file));
  }
}
for (const root of roots) {
  for (const file of walk(root)) {
    if (resolve(file) === SELF) continue; // don't self-flag: this guard's source holds the token
    findings.push(...findingsIn(file));
  }
}

if (findings.length > 0) {
  for (const line of findings) process.stderr.write(`${line}\n`);
  process.exit(DISPOSITION === "warn" ? 0 : 1);
}

process.stdout.write(`${NAME}: ok\n`);
process.exit(0);
