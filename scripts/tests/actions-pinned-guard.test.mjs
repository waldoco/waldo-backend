import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../guards/guard-actions-pinned.mjs', import.meta.url));
const SHA = '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0';
const DIGEST = '0f'.repeat(32);

function withDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'actions-pinned-'));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const runOn = (dir) => spawnSync(process.execPath, [guard, dir], { encoding: 'utf8' });
const check = (files) => withDir(files, runOn);
const steps = (...refs) =>
  `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${refs.map((ref) => `      - uses: ${ref}\n`).join('')}`;
const caller = (ref) => `on: push\njobs:\n  call:\n    uses: ${ref}\n`;

function assertOk(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^guard-actions-pinned: ok \(/);
}
// A finding is one stderr line from this guard naming every part, so a crash or a
// missing guard cannot satisfy a rejection test.
function assertFinding(result, ...parts) {
  assert.equal(result.status, 1, result.stdout);
  const line = result.stderr.split('\n').find((candidate) => parts.every((part) => candidate.includes(part)));
  assert.ok(line?.startsWith('guard-actions-pinned: '), result.stderr);
}

test('accepts commit-pinned actions and reusable workflows, local refs and digest-pinned images', () => {
  assertOk(check({
    'ci.yml': steps(
      `actions/checkout@${SHA} # v7.0.0`,
      `github/codeql-action/init@${SHA}`,
      './.github/actions/setup',
      `docker://alpine@sha256:${DIGEST}`,
      `docker://ghcr.io/org/tool:1.2@sha256:${DIGEST}`,
    ),
    'call.yaml': caller(`org/repo/.github/workflows/ci.yml@${SHA}`),
    'local.yml': caller('./.github/workflows/reusable.yml'),
  }));
});

test('ignores files that are not workflows', () => {
  assertOk(check({ 'ci.yml': steps(`actions/checkout@${SHA}`), 'notes.md': 'uses: actions/checkout@v4\n' }));
});

test('checks this repository\'s workflows by default, wherever it runs from', () => {
  withDir({}, (cwd) => assertOk(spawnSync(process.execPath, [guard], { cwd, encoding: 'utf8' })));
});

for (const ref of [
  'actions/checkout@v4',
  'actions/checkout@v4.2.2',
  'actions/checkout@main',
  'actions/checkout',
  `actions/checkout@${SHA.slice(0, 7)}`,
  `actions/checkout@${SHA.slice(1)}`,
  `actions/checkout@${SHA}0`,
  `actions/checkout@${SHA.toUpperCase()}`,
  'actions/checkout@${{ env.REF }}',
  'github/codeql-action/init@v3',
  'docker://alpine:3.20',
  `docker://alpine@sha256:${DIGEST.slice(1)}`,
]) {
  test(`rejects an unpinned step (${ref})`, () => {
    assertFinding(check({ 'ci.yml': steps(ref) }), 'ci.yml', 'jobs.build.steps[0].uses', JSON.stringify(ref));
  });
}

for (const [label, value, shown] of [['number', '4', '4'], ['empty', '', 'null']]) {
  test(`rejects a step whose uses is not a ref (${label})`, () => {
    assertFinding(check({ 'ci.yml': steps(value) }), 'ci.yml', `jobs.build.steps[0].uses ${shown} `);
  });
}

test('rejects an unpinned reusable workflow call', () => {
  const ref = 'org/repo/.github/workflows/ci.yml@v1';
  assertFinding(check({ 'ci.yml': caller(ref) }), 'ci.yml', 'jobs.call.uses', JSON.stringify(ref));
});

test('reads .yaml workflows too', () => {
  assertFinding(check({ 'ci.yaml': steps('actions/checkout@v4') }), 'ci.yaml', 'jobs.build.steps[0].uses');
});

for (const [label, body] of [
  ['alias', 'env:\n  REF: &floating actions/checkout@v4\njobs:\n  build:\n    steps:\n      - uses: *floating\n'],
  ['merge key', 'x-step: &floating\n  uses: actions/checkout@v4\njobs:\n  build:\n    steps:\n      - <<: *floating\n'],
  ['escaped key', 'jobs:\n  build:\n    steps:\n      - "\\u0075ses": actions/checkout@v4\n'],
  ['flow mapping', 'jobs: {build: {steps: [{uses: actions/checkout@v4}]}}\n'],
]) {
  test(`rejects a floating ref behind YAML syntax (${label})`, () => {
    assertFinding(check({ 'ci.yml': body }), 'ci.yml', 'jobs.build.steps[0].uses', '"actions/checkout@v4"');
  });
}

for (const [label, body] of [
  ['malformed YAML', 'jobs: [\n'],
  ['duplicate key', `jobs:\n  build:\n    steps:\n      - uses: actions/checkout@${SHA}\n        uses: actions/checkout@v4\n`],
  ['alias expansion', 'a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\njobs: {build: {steps: []}}\n'],
  ['no jobs', 'on: push\n'],
  ['steps not a list', 'jobs:\n  build:\n    steps:\n      uses: actions/checkout@v4\n'],
]) {
  test(`fails closed on a workflow it cannot read (${label})`, () => {
    assertFinding(check({ 'ci.yml': body }), 'ci.yml', 'is not a readable workflow');
  });
}

test('fails closed when there is nothing to check', () => {
  assertFinding(check({}), 'no workflow files');
  assertFinding(check({ 'notes.md': 'jobs: {}\n' }), 'no workflow files');
  withDir({}, (dir) => assertFinding(runOn(join(dir, 'absent')), 'no workflow files'));
});

test('reports every finding, not just the first', () => {
  const result = check({
    'a.yml': steps('actions/checkout@v4', `actions/setup-node@${SHA}`, 'pnpm/action-setup@v4'),
    'b.yml': caller('org/repo/.github/workflows/ci.yml@main'),
  });
  assertFinding(result, 'a.yml', 'jobs.build.steps[0].uses');
  assertFinding(result, 'a.yml', 'jobs.build.steps[2].uses');
  assertFinding(result, 'b.yml', 'jobs.call.uses');
  assert.equal(result.stderr.trim().split('\n').length, 3, result.stderr);
});
