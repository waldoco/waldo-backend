#!/usr/bin/env node
// Guard: every relative import reachable from a Supabase edge function names its file extension.
// Edge functions run on Deno, which resolves `./constant-time` as a missing module, while the Worker's bundler accepts
// it, so the Worker tests pass and the function deploy fails at bundling. The functions import runtime source
// (connector-proxy imports packages/runtime/src/connectors), so this walks each function's whole import graph.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DISPOSITION = 'block';

const NAME = 'guard-edge-function-imports';
const SPECIFIER = /\b(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const EXPLICIT = /\.(?:ts|tsx|js|mjs|json)$/;

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const root = rootFlag === -1 ? join(dirname(fileURLToPath(import.meta.url)), '..', '..') : argv[rootFlag + 1];
const functionsDir = join(root, 'supabase', 'functions');

const findings = [];
const seen = new Set();
const entries = existsSync(functionsDir)
  ? readdirSync(functionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(functionsDir, entry.name, 'index.ts'))
  : [];
const stack = entries.filter((file) => existsSync(file));

while (stack.length) {
  const file = normalize(stack.pop());
  if (seen.has(file)) continue;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1];
    const target = join(dirname(file), specifier);
    if (EXPLICIT.test(specifier)) {
      if (existsSync(target)) stack.push(target);
      continue;
    }
    const line = source.slice(0, match.index).split('\n').length;
    findings.push(`${relative(root, file)}:${line} imports '${specifier}' without a file extension`);
    const resolved = [`${target}.ts`, join(target, 'index.ts')].find((candidate) => existsSync(candidate));
    if (resolved) stack.push(resolved);
  }
}

if (findings.length) {
  process.stderr.write(`${NAME}: Deno cannot resolve these imports in an edge function's graph; add the extension:\n${findings.map((finding) => `  ${finding}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`${NAME}: ok (${seen.size} files)\n`);
