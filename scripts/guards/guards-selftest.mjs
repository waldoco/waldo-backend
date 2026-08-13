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
const DO_ONLY_RUNTIME_GUARD = 'scripts/guards/guard-do-only-runtime.mjs';
const DO_MIGRATION_GUARD = 'scripts/guards/guard-do-migration-lineage.mjs';

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

function runDoOnlyRuntimeGuardOn(root) {
  return spawnSync('node', [DO_ONLY_RUNTIME_GUARD, '--root', root], { encoding: 'utf8' });
}

function runDoMigrationGuardOn(root, baseRef) {
  const args = [DO_MIGRATION_GUARD, '--root', root];
  if (baseRef) args.push('--base-ref', baseRef);
  else args.push('--allow-unversioned-fixture');
  const env = { ...process.env };
  delete env.GITHUB_BASE_REF;
  delete env.WALDO_DO_MIGRATION_BASE_REF;
  return spawnSync('node', args, { encoding: 'utf8', env });
}

function runDoMigrationGuardWithoutFixtureMode(root) {
  const env = { ...process.env };
  delete env.GITHUB_BASE_REF;
  delete env.WALDO_DO_MIGRATION_BASE_REF;
  return spawnSync('node', [DO_MIGRATION_GUARD, '--root', root], {
    encoding: 'utf8',
    env,
  });
}

function reportsOnlyPath(result, path) {
  return result.status !== 0 && result.stderr.trim() === path && result.stdout.trim() === '';
}

function reportsClean(result) {
  return result.status === 0 && result.stderr.trim() === '';
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

function withDoMigrationFixture(source, reservations, fn) {
  const root = mkdtempSync(join(tmpdir(), 'guard-selftest-'));
  try {
    const sourcePath = join(root, 'packages/runtime/src/do-schema.ts');
    const reservationPath = join(root, 'packages/runtime/do-migration-reservations.json');
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, source);
    writeFileSync(reservationPath, `${JSON.stringify(reservations, null, 2)}\n`);
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function withMissingDoMigrationInput(source, reservations, fn) {
  const root = mkdtempSync(join(tmpdir(), 'guard-selftest-'));
  try {
    if (source !== undefined) {
      const sourcePath = join(root, 'packages/runtime/src/do-schema.ts');
      mkdirSync(dirname(sourcePath), { recursive: true });
      writeFileSync(sourcePath, source);
    }
    if (reservations !== undefined) {
      const reservationPath = join(root, 'packages/runtime/do-migration-reservations.json');
      mkdirSync(dirname(reservationPath), { recursive: true });
      writeFileSync(reservationPath, `${JSON.stringify(reservations, null, 2)}\n`);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runFixtureGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function withVersionedDoMigrationFixture(baseSource, baseReservations, source, reservations, fn) {
  const root = mkdtempSync(join(tmpdir(), 'guard-selftest-'));
  try {
    const sourcePath = join(root, 'packages/runtime/src/do-schema.ts');
    const reservationPath = join(root, 'packages/runtime/do-migration-reservations.json');
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, baseSource);
    writeFileSync(reservationPath, `${JSON.stringify(baseReservations, null, 2)}\n`);
    runFixtureGit(root, ['init', '--quiet']);
    runFixtureGit(root, ['config', 'user.name', 'Guard Selftest']);
    runFixtureGit(root, ['config', 'user.email', 'guard-selftest@example.invalid']);
    runFixtureGit(root, ['add', '.']);
    runFixtureGit(root, ['commit', '--quiet', '-m', 'base']);
    const baseRef = runFixtureGit(root, ['rev-parse', 'HEAD']);
    writeFileSync(sourcePath, source);
    writeFileSync(reservationPath, `${JSON.stringify(reservations, null, 2)}\n`);
    runFixtureGit(root, ['add', '.']);
    runFixtureGit(root, ['commit', '--quiet', '--allow-empty', '-m', 'current']);
    const headRef = runFixtureGit(root, ['rev-parse', 'HEAD']);
    return fn(root, baseRef, headRef);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

let failures = 0;

const unversionedDoMigration = withDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  runDoMigrationGuardWithoutFixtureMode,
);
if (
  unversionedDoMigration.status === 0 ||
  !unversionedDoMigration.stderr.includes('migration history is unavailable')
) {
  process.stderr.write('guards-selftest: guard-do-migration-lineage ACCEPTED implicit unversioned mode\n');
  failures += 1;
}

const historicalNameRewrite = withVersionedDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  `export const FIRST: DoMigration = { version: 1, name: 'rewritten', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'rewritten' }],
  },
  (root, baseRef) => runDoMigrationGuardOn(root, baseRef),
);
if (
  historicalNameRewrite.status === 0 ||
  !historicalNameRewrite.stderr.includes('historical migration 1 changed')
) {
  process.stderr.write('guards-selftest: guard-do-migration-lineage MISSED historical rewrite\n');
  failures += 1;
}

const historicalSqlEdit = withVersionedDoMigrationFixture(
  `export const FIRST: DoMigration = {
  version: 1,
  name: 'first',
  up: ['CREATE TABLE first (id TEXT PRIMARY KEY);'],
  down: ['DROP TABLE first;'],
};
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  `export const FIRST: DoMigration = {
  version: 1,
  name: 'first',
  up: ['CREATE TABLE rewritten (id TEXT PRIMARY KEY);'],
  down: ['DROP TABLE rewritten;'],
};
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  (root, baseRef) => runDoMigrationGuardOn(root, baseRef),
);
if (!reportsClean(historicalSqlEdit)) {
  process.stderr.write(
    'guards-selftest: guard-do-migration-lineage FALSE POSITIVE on historical SQL edit:\n' +
      historicalSqlEdit.stderr,
  );
  failures += 1;
}

const historicalPostDeclarationSqlEdit = withVersionedDoMigrationFixture(
  `const FIRST_UP = ['CREATE TABLE first (id TEXT PRIMARY KEY);'];
export const FIRST: DoMigration = {
  version: 1,
  name: 'first',
  up: FIRST_UP,
  down: ['DROP TABLE first;'],
};
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  `const FIRST_UP = ['CREATE TABLE first (id TEXT PRIMARY KEY);'];
FIRST_UP[0] = 'CREATE TABLE rewritten (id TEXT PRIMARY KEY);';
export const FIRST: DoMigration = {
  version: 1,
  name: 'first',
  up: FIRST_UP,
  down: ['DROP TABLE first;'],
};
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  (root, baseRef) => runDoMigrationGuardOn(root, baseRef),
);
if (!reportsClean(historicalPostDeclarationSqlEdit)) {
  process.stderr.write(
    'guards-selftest: guard-do-migration-lineage FALSE POSITIVE on out-of-scope SQL edit:\n' +
      historicalPostDeclarationSqlEdit.stderr,
  );
  failures += 1;
}

const historicalAppend = withVersionedDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const SECOND: DoMigration = { version: 2, name: 'second', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST, SECOND] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [
      { version: 1, name: 'first' },
      { version: 2, name: 'second' },
    ],
  },
  (root, baseRef) => runDoMigrationGuardOn(root, baseRef),
);
if (!reportsClean(historicalAppend)) {
  process.stderr.write(
    'guards-selftest: guard-do-migration-lineage FALSE POSITIVE on historical append:\n' +
      historicalAppend.stderr,
  );
  failures += 1;
}

const historicalTriviaChange = withVersionedDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  `export const FIRST: DoMigration = {
  version: 1, // comments and formatting are not executable lineage
  name: 'first',
  up: [],
  down: [], // trailing commas are also non-executable trivia
};
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  (root, baseRef) => runDoMigrationGuardOn(root, baseRef),
);
if (!reportsClean(historicalTriviaChange)) {
  process.stderr.write(
    'guards-selftest: guard-do-migration-lineage FALSE POSITIVE on historical trivia:\n' +
      historicalTriviaChange.stderr,
  );
  failures += 1;
}

const historicalConstantRename = withVersionedDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  `export const RENAMED: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [RENAMED] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  (root, baseRef) => runDoMigrationGuardOn(root, baseRef),
);
if (!reportsClean(historicalConstantRename)) {
  process.stderr.write(
    'guards-selftest: guard-do-migration-lineage FALSE POSITIVE on constant rename:\n' +
      historicalConstantRename.stderr,
  );
  failures += 1;
}

const unavailableHistoricalBase = withVersionedDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  (root) => runDoMigrationGuardOn(root, 'missing-base-ref'),
);
if (
  unavailableHistoricalBase.status === 0 ||
  !unavailableHistoricalBase.stderr.includes('migration base ref "missing-base-ref" is unavailable')
) {
  process.stderr.write('guards-selftest: guard-do-migration-lineage ACCEPTED missing base ref\n');
  failures += 1;
}

const currentHeadHistoricalBase = withVersionedDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  (root, _baseRef, headRef) => runDoMigrationGuardOn(root, headRef),
);
if (
  currentHeadHistoricalBase.status === 0 ||
  !currentHeadHistoricalBase.stderr.includes('must be a strict ancestor of HEAD')
) {
  process.stderr.write('guards-selftest: guard-do-migration-lineage ACCEPTED current HEAD as base\n');
  failures += 1;
}

const nonAncestorHistoricalBase = withVersionedDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  (root, baseRef, headRef) => {
    runFixtureGit(root, ['checkout', '--quiet', baseRef]);
    writeFileSync(join(root, 'sibling-marker.txt'), 'sibling\n');
    runFixtureGit(root, ['add', '.']);
    runFixtureGit(root, ['commit', '--quiet', '-m', 'sibling']);
    const siblingRef = runFixtureGit(root, ['rev-parse', 'HEAD']);
    runFixtureGit(root, ['checkout', '--quiet', headRef]);
    return runDoMigrationGuardOn(root, siblingRef);
  },
);
if (
  nonAncestorHistoricalBase.status === 0 ||
  !nonAncestorHistoricalBase.stderr.includes('must be a strict ancestor of HEAD')
) {
  process.stderr.write('guards-selftest: guard-do-migration-lineage ACCEPTED non-ancestor base\n');
  failures += 1;
}

const duplicateDoMigration = withDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const SECOND: DoMigration = { version: 1, name: 'second', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST, SECOND] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [
      { version: 1, name: 'first' },
      { version: 1, name: 'second' },
    ],
  },
  runDoMigrationGuardOn,
);
if (
  duplicateDoMigration.status === 0 ||
  !duplicateDoMigration.stderr.includes('migration version 1 is duplicated')
) {
  process.stderr.write('guards-selftest: guard-do-migration-lineage MISSED duplicate version\n');
  failures += 1;
}

const duplicateDoMigrationName = withDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'same', up: [], down: [] };
export const SECOND: DoMigration = { version: 2, name: 'same', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST, SECOND] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [
      { version: 1, name: 'same' },
      { version: 2, name: 'same' },
    ],
  },
  runDoMigrationGuardOn,
);
if (
  duplicateDoMigrationName.status === 0 ||
  !duplicateDoMigrationName.stderr.includes('migration name "same" is duplicated')
) {
  process.stderr.write('guards-selftest: guard-do-migration-lineage MISSED duplicate name\n');
  failures += 1;
}

const gappedDoMigration = withDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const THIRD: DoMigration = { version: 3, name: 'third', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST, THIRD] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [
      { version: 1, name: 'first' },
      { version: 3, name: 'third' },
    ],
  },
  runDoMigrationGuardOn,
);
if (gappedDoMigration.status === 0 || !gappedDoMigration.stderr.includes('reserve version 2')) {
  process.stderr.write('guards-selftest: guard-do-migration-lineage MISSED version gap\n');
  failures += 1;
}

const reorderedDoMigration = withDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const SECOND: DoMigration = { version: 2, name: 'second', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [SECOND, FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [
      { version: 1, name: 'first' },
      { version: 2, name: 'second' },
    ],
  },
  runDoMigrationGuardOn,
);
if (
  reorderedDoMigration.status === 0 ||
  !reorderedDoMigration.stderr.includes('reserve version 1')
) {
  process.stderr.write('guards-selftest: guard-do-migration-lineage MISSED reordered chain\n');
  failures += 1;
}

const unreservedDoMigration = withDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const SECOND: DoMigration = { version: 2, name: 'second', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST, SECOND] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  runDoMigrationGuardOn,
);
if (unreservedDoMigration.status === 0 || !unreservedDoMigration.stderr.includes('unreserved')) {
  process.stderr.write('guards-selftest: guard-do-migration-lineage MISSED unreserved migration\n');
  failures += 1;
}

const mismatchedDoMigration = withDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const SECOND: DoMigration = { version: 2, name: 'source-second', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST, SECOND] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [
      { version: 1, name: 'first' },
      { version: 2, name: 'reserved-second' },
    ],
  },
  runDoMigrationGuardOn,
);
if (
  mismatchedDoMigration.status === 0 ||
  !mismatchedDoMigration.stderr.includes('does not match reservation')
) {
  process.stderr.write('guards-selftest: guard-do-migration-lineage MISSED source mismatch\n');
  failures += 1;
}

const malformedDoMigration = withDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: '1', name: 'first' }],
  },
  runDoMigrationGuardOn,
);
if (
  malformedDoMigration.status === 0 ||
  !malformedDoMigration.stderr.includes('migration 1 is malformed')
) {
  process.stderr.write(
    'guards-selftest: guard-do-migration-lineage MISSED malformed reservation\n',
  );
  failures += 1;
}

const missingDoMigrationSource = withMissingDoMigrationInput(
  undefined,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  runDoMigrationGuardOn,
);
if (
  missingDoMigrationSource.status === 0 ||
  !missingDoMigrationSource.stderr.includes('packages/runtime/src/do-schema.ts: required')
) {
  process.stderr.write('guards-selftest: guard-do-migration-lineage MISSED missing source\n');
  failures += 1;
}

const missingDoMigrationReservations = withMissingDoMigrationInput(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  undefined,
  runDoMigrationGuardOn,
);
if (
  missingDoMigrationReservations.status === 0 ||
  !missingDoMigrationReservations.stderr.includes(
    'packages/runtime/do-migration-reservations.json: required',
  )
) {
  process.stderr.write('guards-selftest: guard-do-migration-lineage MISSED missing reservations\n');
  failures += 1;
}

const commentSpoofedDoMigration = withDoMigrationFixture(
  `export const FIRST = {
  version: 99,
  name: 'tampered',
  /* export const FIRST: DoMigration = { version: 1, name: 'first', */
  up: [],
  down: [],
};
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  runDoMigrationGuardOn,
);
if (
  commentSpoofedDoMigration.status === 0 ||
  !commentSpoofedDoMigration.stderr.includes('does not match reservation')
) {
  process.stderr.write('guards-selftest: guard-do-migration-lineage ACCEPTED comment spoof\n');
  failures += 1;
}

const inlineCommentDoMigration = withDoMigrationFixture(
  `export const FIRST: DoMigration = {
  version: 1, // versions remain contiguous
  name: 'first',
  up: [],
  down: [],
};
export const DO_SCHEMA_MIGRATIONS = [FIRST] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [{ version: 1, name: 'first' }],
  },
  runDoMigrationGuardOn,
);
if (!reportsClean(inlineCommentDoMigration)) {
  process.stderr.write(
    'guards-selftest: guard-do-migration-lineage FALSE POSITIVE on inline comment:\n' +
      inlineCommentDoMigration.stderr,
  );
  failures += 1;
}

const cleanDoMigration = withDoMigrationFixture(
  `export const FIRST: DoMigration = { version: 1, name: 'first', up: [], down: [] };
export const SECOND: DoMigration = { version: 2, name: 'second', up: [], down: [] };
export const DO_SCHEMA_MIGRATIONS = [FIRST, SECOND] as const;
`,
  {
    allocation: 'rebase_then_append',
    migrations: [
      { version: 1, name: 'first' },
      { version: 2, name: 'second' },
    ],
  },
  runDoMigrationGuardOn,
);
if (!reportsClean(cleanDoMigration)) {
  process.stderr.write(
    `guards-selftest: guard-do-migration-lineage FALSE POSITIVE on a clean chain:\n${cleanDoMigration.stderr}`,
  );
  failures += 1;
}

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

const invokeAgentViolation = withFixture(
  'packages/runtime/src/run-loop/do.ts',
  "const endpoint = 'invoke-agent';\n",
  runDoOnlyRuntimeGuardOn,
);
if (!reportsOnlyPath(invokeAgentViolation, 'packages/runtime/src/run-loop/do.ts')) {
  process.stderr.write('guards-selftest: guard-do-only-runtime MISSED invoke-agent in runtime source\n');
  failures += 1;
}

const packageSourceInvokeAgentViolation = withFixture(
  'packages/other/src/worker.ts',
  "const endpoint = 'invoke-agent';\n",
  runDoOnlyRuntimeGuardOn,
);
if (!reportsOnlyPath(packageSourceInvokeAgentViolation, 'packages/other/src/worker.ts')) {
  process.stderr.write(
    'guards-selftest: guard-do-only-runtime MISSED invoke-agent in package source\n',
  );
  failures += 1;
}

const packageNonSrcInvokeAgentViolation = withFixture(
  'packages/other/scripts/worker.ts',
  "const endpoint = 'invoke-agent';\n",
  runDoOnlyRuntimeGuardOn,
);
if (!reportsOnlyPath(packageNonSrcInvokeAgentViolation, 'packages/other/scripts/worker.ts')) {
  process.stderr.write(
    'guards-selftest: guard-do-only-runtime MISSED invoke-agent in non-src package source\n',
  );
  failures += 1;
}

const packageConfigInvokeAgentViolation = withFixture(
  'packages/other/wrangler.jsonc',
  '{ "entrypoint": "invoke-agent" }\n',
  runDoOnlyRuntimeGuardOn,
);
if (!reportsOnlyPath(packageConfigInvokeAgentViolation, 'packages/other/wrangler.jsonc')) {
  process.stderr.write(
    'guards-selftest: guard-do-only-runtime MISSED invoke-agent in package config\n',
  );
  failures += 1;
}

const rootSourceInvokeAgentViolation = withFixture(
  'src/worker.ts',
  "const endpoint = 'invoke-agent';\n",
  runDoOnlyRuntimeGuardOn,
);
if (!reportsOnlyPath(rootSourceInvokeAgentViolation, 'src/worker.ts')) {
  process.stderr.write('guards-selftest: guard-do-only-runtime MISSED invoke-agent in root source\n');
  failures += 1;
}

const rootConfigInvokeAgentViolation = withFixture(
  'src/route.json',
  '{ "entrypoint": "invoke-agent" }\n',
  runDoOnlyRuntimeGuardOn,
);
if (!reportsOnlyPath(rootConfigInvokeAgentViolation, 'src/route.json')) {
  process.stderr.write('guards-selftest: guard-do-only-runtime MISSED invoke-agent in root config\n');
  failures += 1;
}

const testSourceReference = withFixture(
  'packages/other/src/worker.test.ts',
  "const endpoint = 'invoke-agent';\n",
  runDoOnlyRuntimeGuardOn,
);
if (!reportsClean(testSourceReference)) {
  process.stderr.write(
    `guards-selftest: guard-do-only-runtime FALSE POSITIVE in a test source:\n${testSourceReference.stderr}`,
  );
  failures += 1;
}

const docsSourceReference = withFixture(
  'packages/other/src/docs/example.ts',
  "const endpoint = 'invoke-agent';\n",
  runDoOnlyRuntimeGuardOn,
);
if (!reportsClean(docsSourceReference)) {
  process.stderr.write(
    `guards-selftest: guard-do-only-runtime FALSE POSITIVE in docs:\n${docsSourceReference.stderr}`,
  );
  failures += 1;
}

const dependencySourceReference = withFixture(
  'packages/other/src/node_modules/example/index.ts',
  "const endpoint = 'invoke-agent';\n",
  runDoOnlyRuntimeGuardOn,
);
if (!reportsClean(dependencySourceReference)) {
  process.stderr.write(
    `guards-selftest: guard-do-only-runtime FALSE POSITIVE in node_modules:\n${dependencySourceReference.stderr}`,
  );
  failures += 1;
}

const nonRuntimeServiceRoleBinding = withFixture(
  'packages/other/src/worker.ts',
  'const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;\n',
  runDoOnlyRuntimeGuardOn,
);
if (!reportsClean(nonRuntimeServiceRoleBinding)) {
  process.stderr.write(
    `guards-selftest: guard-do-only-runtime FALSE POSITIVE on non-runtime service-role binding:\n${nonRuntimeServiceRoleBinding.stderr}`,
  );
  failures += 1;
}

const invokeAgentCamelCaseViolation = withFixture(
  'packages/runtime/src/run-loop/do.ts',
  'const invokeAgent = () => undefined;\n',
  runDoOnlyRuntimeGuardOn,
);
if (!reportsOnlyPath(invokeAgentCamelCaseViolation, 'packages/runtime/src/run-loop/do.ts')) {
  process.stderr.write('guards-selftest: guard-do-only-runtime MISSED invokeAgent in runtime source\n');
  failures += 1;
}

const serviceRoleRuntimeViolation = withFixture(
  'packages/runtime/src/run-loop/do.ts',
  'const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;\n',
  runDoOnlyRuntimeGuardOn,
);
if (!reportsOnlyPath(serviceRoleRuntimeViolation, 'packages/runtime/src/run-loop/do.ts')) {
  process.stderr.write(
    'guards-selftest: guard-do-only-runtime MISSED SUPABASE_SERVICE_ROLE_KEY in runtime source\n',
  );
  failures += 1;
}

const serviceRoleRuntimeNonSrcViolation = withFixture(
  'packages/runtime/worker.ts',
  'const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;\n',
  runDoOnlyRuntimeGuardOn,
);
if (!reportsOnlyPath(serviceRoleRuntimeNonSrcViolation, 'packages/runtime/worker.ts')) {
  process.stderr.write(
    'guards-selftest: guard-do-only-runtime MISSED SUPABASE_SERVICE_ROLE_KEY in non-src runtime file\n',
  );
  failures += 1;
}

const serviceRoleConfigViolation = withFixture(
  'packages/runtime/wrangler.toml',
  '[vars]\nSUPABASE_SERVICE_ROLE_KEY = "fixture-only"\n',
  runDoOnlyRuntimeGuardOn,
);
if (!reportsOnlyPath(serviceRoleConfigViolation, 'packages/runtime/wrangler.toml')) {
  process.stderr.write(
    'guards-selftest: guard-do-only-runtime MISSED SUPABASE_SERVICE_ROLE_KEY in wrangler.toml\n',
  );
  failures += 1;
}

const serviceRoleJsoncConfigViolation = withFixture(
  'packages/runtime/wrangler.jsonc',
  '{ "vars": { "SUPABASE_SERVICE_ROLE_KEY": "fixture-only" } }\n',
  runDoOnlyRuntimeGuardOn,
);
if (!reportsOnlyPath(serviceRoleJsoncConfigViolation, 'packages/runtime/wrangler.jsonc')) {
  process.stderr.write(
    'guards-selftest: guard-do-only-runtime MISSED SUPABASE_SERVICE_ROLE_KEY in wrangler.jsonc\n',
  );
  failures += 1;
}

const serviceRoleJsonConfigViolation = withFixture(
  'packages/runtime/wrangler.json',
  '{ "vars": { "SUPABASE_SERVICE_ROLE_KEY": "fixture-only" } }\n',
  runDoOnlyRuntimeGuardOn,
);
if (!reportsOnlyPath(serviceRoleJsonConfigViolation, 'packages/runtime/wrangler.json')) {
  process.stderr.write(
    'guards-selftest: guard-do-only-runtime MISSED SUPABASE_SERVICE_ROLE_KEY in wrangler.json\n',
  );
  failures += 1;
}

const doOnlyRuntimeClean = withFixture(
  'packages/runtime/src/run-loop/do.ts',
  'export class RunLoopDO {}\n',
  runDoOnlyRuntimeGuardOn,
);
if (doOnlyRuntimeClean.status !== 0 || doOnlyRuntimeClean.stderr.trim() !== '') {
  process.stderr.write(
    `guards-selftest: guard-do-only-runtime FALSE POSITIVE on clean runtime source:\n${doOnlyRuntimeClean.stderr}`,
  );
  failures += 1;
}

const retiredSupabaseFunctionPathViolation = withFixture(
  'supabase/functions/invoke-agent/index.ts',
  'Deno.serve(() => new Response("ok"));\n',
  runDoOnlyRuntimeGuardOn,
);
if (
  !reportsOnlyPath(
    retiredSupabaseFunctionPathViolation,
    'supabase/functions/invoke-agent/index.ts',
  )
) {
  process.stderr.write(
    'guards-selftest: guard-do-only-runtime MISSED retired supabase/functions/invoke-agent route\n',
  );
  failures += 1;
}

const retiredSupabaseFunctionTestFile = withFixture(
  'supabase/functions/invoke-agent/index.test.ts',
  'Deno.serve(() => new Response("ok"));\n',
  runDoOnlyRuntimeGuardOn,
);
if (!reportsClean(retiredSupabaseFunctionTestFile)) {
  process.stderr.write(
    `guards-selftest: guard-do-only-runtime FALSE POSITIVE in retired-route test source:\n${retiredSupabaseFunctionTestFile.stderr}`,
  );
  failures += 1;
}

const retiredSupabaseFunctionReferenceViolation = withFixture(
  'supabase/functions/mint-agent-jwt/index.ts',
  "const retiredPath = 'invoke-agent';\n",
  runDoOnlyRuntimeGuardOn,
);
if (
  !reportsOnlyPath(
    retiredSupabaseFunctionReferenceViolation,
    'supabase/functions/mint-agent-jwt/index.ts',
  )
) {
  process.stderr.write(
    'guards-selftest: guard-do-only-runtime MISSED invoke-agent reference in supabase function\n',
  );
  failures += 1;
}

const legitimateSupabaseFunction = withFixture(
  'supabase/functions/mint-agent-jwt/index.ts',
  'Deno.serve(() => new Response("ok"));\n',
  runDoOnlyRuntimeGuardOn,
);
if (legitimateSupabaseFunction.status !== 0 || legitimateSupabaseFunction.stderr.trim() !== '') {
  process.stderr.write(
    `guards-selftest: guard-do-only-runtime FALSE POSITIVE on mint-agent-jwt:\n${legitimateSupabaseFunction.stderr}`,
  );
  failures += 1;
}

if (failures > 0) process.exit(1);
process.stdout.write('guards-selftest: ok\n');
