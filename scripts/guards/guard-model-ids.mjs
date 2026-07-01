#!/usr/bin/env node
// guard-model-ids — model identifiers are a single-owner contract (ADR-0069).
// Model-id-shaped string literals may live only in the canonical roster source.
// Anywhere else under the scan roots they are the B1 drift class (a phantom id
// shipped in a scattered literal), so any match blocks the wall.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export const DISPOSITION = 'block';

const NAME = 'guard-model-ids';

// The one file allowed to define roster ids, and its co-located conformance test.
// The test's negative cases assert on raw non-roster literals that cannot be
// imported from the roster, so it is the only other place raw ids are correct.
const EXEMPT_FILES = [
  ['packages', 'contracts', 'src', 'model', 'roster.ts'].join('/'),
  ['packages', 'contracts', 'src', 'model', 'roster.test.ts'].join('/'),
];
// The guards themselves are the detection layer; their pattern sources describe
// the id shape and must not be scanned for it.
const EXEMPT_DIR_PREFIX = ['scripts', 'guards'].join('/') + '/';

const SCAN_DIRS = ['packages', 'scripts', '.github'];
const SCAN_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.json', '.jsonc', '.yml', '.yaml', '.toml', '.md',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

// Vendor prefixes whose bare id shape ("<vendor>-<version-ish>") we forbid, plus
// the Workers-AI binding prefix. Assembled from parts so this source line does
// not itself form a scannable id literal.
const VENDORS = ['gemma', 'claude', 'gpt', 'gemini', 'deepseek', 'llama'];
const CF = '@' + 'cf/';

// A bare vendor id: vendor token, hyphen, then a run of id characters that
// contains at least one digit (a real version), to avoid flagging English prose
// like "claude-native" or "llama-farm". \b anchors the vendor start; the
// lookahead requires a digit somewhere in the run, wherever it falls.
const BARE_ID = new RegExp(
  '\\b(?:' + VENDORS.join('|') + ')-(?=[a-z0-9._-]*[0-9])[a-z0-9._-]+',
  'i',
);
// A Workers-AI model path: the binding prefix followed by a vendor/model segment.
const CF_PATH = new RegExp(
  CF.replace('/', '\\/') + '[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._-]+',
  'i',
);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      if (dot >= 0 && SCAN_EXT.has(entry.name.slice(dot))) out.push(full);
    }
  }
}

function isExempt(relPath) {
  if (EXEMPT_FILES.includes(relPath)) return true;
  return relPath.startsWith(EXEMPT_DIR_PREFIX);
}

function scanFile(root, file, findings) {
  let rel = relative(root, file).split(sep).join('/');
  if (isExempt(rel)) return;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (BARE_ID.test(line) || CF_PATH.test(line)) {
      findings.push(
        rel + ':' + (i + 1) +
          ': model-identifier literal outside packages/contracts/src/model/roster.ts (ADR-0069: model ids are single-owner)',
      );
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  let root = process.cwd();
  const rootFlag = args.indexOf('--root');
  if (rootFlag !== -1 && args[rootFlag + 1]) {
    root = resolve(args[rootFlag + 1]);
  }

  const files = [];
  for (const d of SCAN_DIRS) {
    const dir = resolve(root, d);
    try {
      if (statSync(dir).isDirectory()) walk(dir, files);
    } catch {
      // Root may point at a scratch fixture that mirrors only some scan dirs.
    }
  }

  const findings = [];
  for (const file of files) scanFile(root, file, findings);

  if (findings.length > 0) {
    for (const f of findings) process.stderr.write(f + '\n');
    process.exit(1);
  }
  process.stdout.write(NAME + ': ok\n');
  process.exit(0);
}

main();
