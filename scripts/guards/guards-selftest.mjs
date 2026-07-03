#!/usr/bin/env node
// guards-selftest — plants a known violation in a temp root and asserts the guard reports it:
// a guard that stays silent on its own target is a broken wall, and nothing else would notice.
// Lives inside scripts/guards/ so the verify loop runs it and the health-leak scanner's
// guards-dir skip keeps the fixture strings below out of repo scans.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GUARD = 'scripts/guards/guard-health-leak.mjs';

const LEAK_CASES = [
  { name: 'same-line assignment', code: 'const hrv = 42;\n' },
  { name: 'multi-line assignment', code: 'const sleepHours =\n  7.5;\n' },
  {
    name: 'multi-line template interpolation',
    code: 'const msg = `resting heart rate\n is ${88} bpm`;\n',
  },
  { name: 'sink call spread over lines', code: 'console.log(\n  "spo2",\n  95,\n);\n' },
];

function runGuardOn(root) {
  return spawnSync('node', [GUARD, '--root', root], { encoding: 'utf8' });
}

function withFixture(fileName, code, fn) {
  const root = mkdtempSync(join(tmpdir(), 'guard-selftest-'));
  try {
    writeFileSync(join(root, fileName), code);
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

let failures = 0;

for (const c of LEAK_CASES) {
  const res = withFixture('leak.ts', c.code, runGuardOn);
  if (!res.stderr.includes('leak.ts')) {
    process.stderr.write(`guards-selftest: guard-health-leak MISSED "${c.name}"\n`);
    failures += 1;
  }
}

// A clean file must stay clean: `threshold` probes the \bhr\b word boundary; zone=peak is the
// permitted stable-label form.
const clean = withFixture('clean.ts', 'const zone = "peak";\nconst threshold = 42;\n', runGuardOn);
if (clean.stderr.trim() !== '') {
  process.stderr.write(
    `guards-selftest: guard-health-leak FALSE POSITIVE on a clean file:\n${clean.stderr}`,
  );
  failures += 1;
}

if (failures > 0) process.exit(1);
process.stdout.write('guards-selftest: ok\n');
