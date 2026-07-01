#!/usr/bin/env node
// guard-stale-types — blocks imports from the retired external contracts package.
// Contract source: packages/contracts (workspace:*). See ADR-0029 § Amendment 2026-06-29.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

export const DISPOSITION = 'block';

const NAME = 'guard-stale-types';

// Retired package specifier. Assembled from parts so this guard's own source never
// contains the contiguous needle — the default scan includes scripts/, i.e. this file.
const RETIRED = ['@waldo', 'types'].join('/');

// Package-boundary invariant: a specifier matches only when it is the retired package
// itself or one of its subpaths — the char after the prefix must be end-of-string or '/'.
// This deliberately does NOT flag a different package that merely shares the prefix.
function isRetired(specifier) {
  if (!specifier.startsWith(RETIRED)) return false;
  const next = specifier.charAt(RETIRED.length);
  return next === '' || next === '/';
}

const SCANNED_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json']);

// Capture the module specifier from the four ways code can name a dependency:
//   import ... from '<spec>'   |   export ... from '<spec>'   |   import '<spec>'
//   require('<spec>')          |   import('<spec>')
// Global so multiple import/require constructs on one line are all seen (a
// non-global .exec stops at the leftmost match — proven bypassable by the attack).
const SPECIFIER_PATTERNS = [
  /(?:^|[^.\w])(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /(?:^|[^.\w])import\s*['"]([^'"]+)['"]/g,
  /(?:^|[^.\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:^|[^.\w])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

// The retired package also leaks in as a bare quoted string value — bundler
// `external` lists, tsconfig `paths`, alias maps — which is not an import
// construct. Non-global so `.test()` stays stateless. Assembled-from-parts and
// homoglyph evasions are out of a grep wall's reach and are documented, not caught.
const RETIRED_LITERAL = /['"]@waldo\/types(?:\/[^'"]*)?['"]/;

function specifiersOnLine(line) {
  const found = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const m of line.matchAll(pattern)) found.push(m[1]);
  }
  return found;
}

function hasRetiredLiteral(line) {
  return RETIRED_LITERAL.test(line);
}

function extname(path) {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing root (e.g. .github/) or unreadable dir — skip, don't crash
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && SCANNED_EXT.has(extname(entry.name))) {
      yield full;
    }
  }
}

function scanFile(file, base, violations) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    let flagged = false;
    for (const spec of specifiersOnLine(line)) {
      if (isRetired(spec)) {
        violations.push({ file: relative(base, file), line: i + 1, specifier: spec });
        flagged = true;
      }
    }
    if (!flagged && hasRetiredLiteral(line)) {
      violations.push({ file: relative(base, file), line: i + 1, specifier: RETIRED });
    }
  });
}

function findViolations(roots, base) {
  const violations = [];
  for (const root of roots) {
    let exists = true;
    try {
      statSync(root);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    for (const file of walk(root)) scanFile(file, base, violations);
  }
  return violations;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..'); // scripts/guards -> scripts -> repo root

  const args = process.argv.slice(2);
  const rootFlag = args.indexOf('--root');
  const scanRoot = rootFlag !== -1 ? resolve(args[rootFlag + 1]) : null;

  const roots = scanRoot
    ? [scanRoot]
    : [join(repoRoot, 'packages'), join(repoRoot, 'scripts'), join(repoRoot, '.github')];
  const base = scanRoot ?? repoRoot;

  const violations = findViolations(roots, base);

  // Also scan the repo root's own top-level files (default mode only). A retired
  // dependency can be declared in the root package.json — a sibling of the scanned
  // sub-trees that walk() never reaches.
  if (!scanRoot) {
    for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
      if (entry.isFile() && SCANNED_EXT.has(extname(entry.name))) {
        scanFile(join(repoRoot, entry.name), base, violations);
      }
    }
  }

  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(
        `${v.file}:${v.line}: retired contract import "${v.specifier}" — import from packages/contracts (workspace:*) per ADR-0029 Amendment 2026-06-29\n`,
      );
    }
    process.exit(1);
  }

  process.stdout.write(`${NAME}: ok\n`);
  process.exit(0);
}

main();
