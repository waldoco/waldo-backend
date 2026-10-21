#!/usr/bin/env node
// guard-surface-neutral-core — the runtime core decides by declared capability, not by
// which surface a turn came from. Every comparison against the surface list in
// packages/runtime/src is counted per file and held to the committed baseline: a file
// may only lose compares. The surface list is read from the app contract so a new
// surface is ratcheted the day it is declared. Raising a baseline number is the
// backend lead's merge-gate decision; lowering one is the author's duty in the same PR.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, sep } from 'node:path';

export const DISPOSITION = 'block';

const NAME = 'guard-surface-neutral-core';
const SCAN_ROOT = ['packages', 'runtime', 'src'];
const SURFACES_SOURCE = ['packages', 'contracts', 'src', 'app', 'surfaces.ts'];
const BASELINE = ['scripts', 'guards', 'guard-surface-neutral-core.baseline.json'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const TEST_FILE = /(?:\.|_)(?:spec|test)\.[^.]+$/i;

function parseRoot(argv) {
  const index = argv.indexOf('--root');
  if (index !== -1) {
    const value = argv[index + 1];
    if (!value) {
      process.stderr.write(`${NAME}: --root requires a directory argument\n`);
      process.exit(2);
    }
    return resolve(value);
  }
  return fileURLToPath(new URL('../../', import.meta.url));
}

function readInput(path, describe) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    process.stderr.write(`${NAME}: ${describe} is missing: ${path}\n`);
    process.exit(2);
  }
}

// The contract declares the messaging names in one array and spreads them into the
// surface enum; every quoted name inside either array is a surface.
function readSurfaces(root) {
  const path = join(root, ...SURFACES_SOURCE);
  const names = new Set();
  for (const [, list] of readInput(path, 'the surface contract').matchAll(
    /(?:MESSAGING_SURFACES\s*=|z\.enum\()\s*\[([^\]]*)\]/g,
  )) {
    for (const [, name] of list.matchAll(/'([a-z_]+)'/g)) names.add(name);
  }
  if (names.size < 2) {
    process.stderr.write(`${NAME}: could not read the surface list from ${path}\n`);
    process.exit(2);
  }
  return [...names];
}

// A surface compare is a strict comparison with a surface name on either side, or with
// the identifier `channel` or `surface` on either side (a `typeof` check is a shape check,
// not a branch), or a switch case on a surface name.
function surfaceComparePattern(surfaces) {
  const name = `['"](?:${surfaces.join('|')})['"]`;
  const operator = '(?:===|!==)';
  const binding = '(?:channel|surface)';
  return new RegExp(
    [
      `(?<!\\btypeof\\s+[\\w$.?]*)\\b${binding}\\s*${operator}`,
      `${operator}\\s*${binding}\\b`,
      `${name}\\s*${operator}`,
      `${operator}\\s*${name}`,
      `\\bcase\\s+${name}\\s*:`,
    ].join('|'),
    'g',
  );
}

function walk(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(file, files);
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.'))) &&
      !TEST_FILE.test(entry.name)
    ) {
      files.push(file);
    }
  }
}

function countCompares(file, pattern) {
  const hits = [];
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      const matches = line.match(pattern);
      if (matches) hits.push({ line: index + 1, text: line.trim(), count: matches.length });
    });
  return hits;
}

function main() {
  const root = parseRoot(process.argv.slice(2));
  const pattern = surfaceComparePattern(readSurfaces(root));
  const baseline = JSON.parse(readInput(join(root, ...BASELINE), 'the baseline'));
  const scanRoot = join(root, ...SCAN_ROOT);
  if (!statSync(scanRoot, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write(`${NAME}: scan root is missing: ${scanRoot}\n`);
    process.exit(2);
  }
  const files = [];
  walk(scanRoot, files);

  const counts = new Map(Object.keys(baseline).map((path) => [path, 0]));
  const hitsByFile = new Map();
  for (const file of files) {
    const hits = countCompares(file, pattern);
    if (hits.length === 0) continue;
    const path = relative(root, file).split(sep).join('/');
    counts.set(path, hits.reduce((sum, hit) => sum + hit.count, 0));
    hitsByFile.set(path, hits);
  }

  const findings = [];
  for (const [path, actual] of [...counts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const expected = baseline[path] ?? 0;
    if (actual > expected) {
      findings.push(
        `${path}: ${actual} surface compares, baseline ${expected}: the core branches on the ` +
          `surface list in ${actual - expected} new place(s). Decide by declared capability or ` +
          `move the branch into the surface adapter; raising the baseline in ` +
          `${BASELINE.join('/')} is the backend lead's merge-gate decision.`,
      );
      for (const hit of hitsByFile.get(path)) findings.push(`  ${path}:${hit.line}: ${hit.text}`);
    } else if (actual < expected) {
      findings.push(
        `${path}: ${actual} surface compares, baseline ${expected}: ` +
          (actual === 0 ? 'remove its entry from' : `lower it to ${actual} in`) +
          ` ${BASELINE.join('/')}.`,
      );
    }
  }

  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`${finding}\n`);
    process.exit(1);
  }

  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  process.stdout.write(`${NAME}: ok (${total} surface compares in ${hitsByFile.size} files)\n`);
}

main();
