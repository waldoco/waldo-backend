#!/usr/bin/env node
// guards-selftest — plants a known violation in a temp root and asserts the guard reports it:
// a guard that stays silent on its own target is a broken wall, and nothing else would notice.
// Lives inside scripts/guards/ so the verify loop runs it and the health-leak scanner's
// guards-dir skip keeps the fixture strings below out of repo scans.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const GUARD = 'scripts/guards/guard-health-leak.mjs';
const FAKE_CALLBACK_GUARD = 'scripts/guards/guard-fake-callbacks.mjs';

const LEAK_CASES = [
  { name: 'same-line assignment', code: 'const hrv = 42;\n' },
  { name: 'multi-line assignment', code: 'const sleepHours =\n  7.5;\n' },
  {
    name: 'multi-line template interpolation',
    code: 'const msg = `resting heart rate\n is ${88} bpm`;\n',
  },
  { name: 'sink call spread over lines', code: 'console.log(\n  "spo2",\n  95,\n);\n' },
  // Structured/serialized payloads: quoted values, snake_case keys, and camelCase quoted ratios —
  // the shape health data actually takes in JSON/object literals, which prose-only detectors miss.
  { name: 'quoted raw value', code: 'const p = { hrv: "42" };\n' },
  { name: 'snake_case structured key', code: 'const p = { body_weight: 82 };\n' },
  { name: 'camelCase quoted ratio', code: 'const p = { bloodPressure: "140/90" };\n' },
  { name: 'unit-suffixed key', code: 'const p = { hrv_ms: 42, weight_kg: 82 };\n' },
  { name: 'bare bp quoted ratio', code: 'const p = { bp: "140/90" };\n' },
  { name: 'bp systolic/diastolic aliases', code: 'const p = { bpSys: 140, bpDia: 90 };\n' },
];

function runGuardOn(root) {
  return spawnSync('node', [GUARD, '--root', root], { encoding: 'utf8' });
}

function runFakeCallbackGuardOn(root) {
  return spawnSync('node', [FAKE_CALLBACK_GUARD, '--root', root], { encoding: 'utf8' });
}

function withFixture(fileName, code, fn) {
  const root = mkdtempSync(join(tmpdir(), 'guard-selftest-'));
  try {
    const fixturePath = join(root, fileName);
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, code);
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

// Zone-only prose is the sanctioned external form: derived zone words carry no raw number, so the
// raw-sensor wall must let them through even alongside an unrelated numeric literal.
const zoneProse = withFixture(
  'zone.ts',
  'const note = "recovery solid, form energized";\nconst pct = 42;\n',
  runGuardOn,
);
if (zoneProse.stderr.trim() !== '') {
  process.stderr.write(
    `guards-selftest: guard-health-leak FALSE POSITIVE on zone-only prose:\n${zoneProse.stderr}`,
  );
  failures += 1;
}

// Bare `bp` without a ratio/mmHg unit is ambiguous with basis points and must not be blocked.
const basisPoints = withFixture(
  'basis-points.ts',
  'const change = { bp: 3, note: "basis points move" };\n',
  runGuardOn,
);
if (basisPoints.stderr.trim() !== '') {
  process.stderr.write(
    `guards-selftest: guard-health-leak FALSE POSITIVE on basis-points shorthand:\n${basisPoints.stderr}`,
  );
  failures += 1;
}

const fakeCallbackViolation = withFixture(
  'packages/runtime/src/run-loop/do.ts',
  `class RunLoopDO {
  constructor() {
    this.gateway = new FakeRunLoopGateway();
  }
  rebuildInvocationContext() {
    return {
      rateLimitCheck: () => true,
      hasApproval: () => true,
      sanitise: ({ text }) => ({ ok: true, output: text, redactions: [] }),
      medicalGate: () => true,
    };
  }
}
`,
  runFakeCallbackGuardOn,
);
if (!fakeCallbackViolation.stderr.includes('packages/runtime/src/run-loop/do.ts')) {
  process.stderr.write('guards-selftest: guard-fake-callbacks MISSED production fake/stub wiring\n');
  failures += 1;
}

const fakeCallbackClean = withFixture(
  'packages/runtime/src/run-loop/do.ts',
  `class RunLoopDO {
  constructor(env) {
    this.adapters = resolveRunLoopAdapters(env);
  }
}
`,
  runFakeCallbackGuardOn,
);
if (fakeCallbackClean.stderr.trim() !== '') {
  process.stderr.write(
    `guards-selftest: guard-fake-callbacks FALSE POSITIVE on resolver wiring:\n${fakeCallbackClean.stderr}`,
  );
  failures += 1;
}

if (failures > 0) process.exit(1);
process.stdout.write('guards-selftest: ok\n');
