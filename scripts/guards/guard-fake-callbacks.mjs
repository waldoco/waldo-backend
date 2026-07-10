#!/usr/bin/env node
// guard-fake-callbacks — RunLoopDO production wiring must resolve adapters/callbacks
// through the config seam. Local fakes may live in the test/local adapter module, but the
// DO constructor and invocation context must not silently construct fake gateways/sinks or
// permissive safety callbacks.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DISPOSITION = 'block';

const TARGET = ['packages', 'runtime', 'src', 'run-loop', 'do.ts'].join('/');

const VIOLATIONS = [
  {
    re: /new\s+FakeRunLoopGateway\s*\(/,
    reason: 'RunLoopDO must not construct FakeRunLoopGateway directly',
  },
  {
    re: /new\s+RunLoopFakeSink\s*\(/,
    reason: 'RunLoopDO must not construct RunLoopFakeSink directly',
  },
  {
    re: /rateLimitCheck\s*:\s*\(\s*\)\s*=>\s*true/,
    reason: 'RunLoopDO must not hard-code permissive rateLimitCheck',
  },
  {
    re: /hasApproval\s*:\s*\(\s*\)\s*=>\s*true/,
    reason: 'RunLoopDO must not hard-code permissive approval',
  },
  {
    re: /medicalGate\s*:\s*\(\s*\)\s*=>\s*true/,
    reason: 'RunLoopDO must not hard-code permissive medicalGate',
  },
  {
    re: /sanitise\s*:\s*\(\s*\{\s*text\s*\}\s*\)\s*=>\s*\(\s*\{[^}]*output\s*:\s*text/s,
    reason: 'RunLoopDO must not hard-code pass-through sanitise',
  },
];

function main() {
  const args = process.argv.slice(2);
  let root = process.cwd();
  const rootFlag = args.indexOf('--root');
  if (rootFlag !== -1 && args[rootFlag + 1]) {
    root = resolve(args[rootFlag + 1]);
  }

  const file = join(root, TARGET);
  if (!existsSync(file)) return;

  const text = readFileSync(file, 'utf8');
  const findings = [];
  for (const violation of VIOLATIONS) {
    const match = violation.re.exec(text);
    if (match?.index !== undefined) {
      findings.push(`${TARGET}:${lineFor(text, match.index)}: ${violation.reason}`);
    }
  }

  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`${finding}\n`);
    process.exit(1);
  }
}

function lineFor(text, index) {
  return text.slice(0, index).split('\n').length;
}

main();
