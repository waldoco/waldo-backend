import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../guards/guard-ci-failure.mjs', import.meta.url));
function check(body) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-failure-'));
  try {
    const path = join(dir, 'verify.yml');
    writeFileSync(path, body);
    return spawnSync(process.execPath, [guard, path], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
for (const value of ['true', '${{ always() }}', '"true"', '', 'yes']) {
  test(`rejects a softened job or step (${value})`, () => {
    for (const indent of ['    ', '        ']) {
      const result = check(`jobs:\n  runtime:\n${indent}continue-on-error: ${value}\n`);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /allows a failed verification/);
    }
  });
}
test('allows hard failures, explicit false and comments', () => {
  assert.equal(check('jobs:\n  runtime:\n    continue-on-error: false # hard gate\n    # continue-on-error: true\n').status, 0);
});
test('current verification workflow cannot soften a failed test', () => {
  assert.equal(spawnSync(process.execPath, [guard], { encoding: 'utf8' }).status, 0);
});

for (const syntax of ['    "continue-on-error": true', '    runtime: {continue-on-error: true}', "    'continue-on-error': ${{ true }}"]) {
  test(`rejects alternate syntax (${syntax})`, () => {
    assert.equal(check(`${syntax}\n`).status, 1);
  });
}
