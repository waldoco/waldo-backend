import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildResponsibilityClosureV06Bundle } from '../packages/contracts/src/protocol/responsibility-closure-v0-6-fixtures';
import {
  createClosureProjectionPageVerifierV06,
  createVerifiedAcceptanceBindingVerifierV06,
} from '../packages/contracts/src/protocol/responsibility-closure-v0-6';

describe('generate responsibility closure v0.6 fixtures', () => {
  it('writes the version-pinned digest-coherent fixture bundle', () => {
    const directory = new URL(
      '../packages/contracts/fixtures/responsibility-closure/v0.6/',
      import.meta.url,
    );
    mkdirSync(directory, { recursive: true });
    const sourceSha256 = createHash('sha256').update(readFileSync(new URL(
      '../packages/contracts/src/protocol/responsibility-closure-v0-6.ts',
      import.meta.url,
    ))).digest('hex');
    const hashHex = (value: string): string => createHash('sha256').update(value).digest('hex');
    const bundle = buildResponsibilityClosureV06Bundle(hashHex, sourceSha256);
    const binding = JSON.parse(bundle['verified-acceptance-binding.valid.json']!);
    expect(() => createVerifiedAcceptanceBindingVerifierV06(hashHex)(
      binding,
      binding.activeAcceptanceChecks,
    )).not.toThrow();
    expect(() => createClosureProjectionPageVerifierV06(hashHex)(
      JSON.parse(bundle['closure-projection-page.valid.json']!),
    )).not.toThrow();
    for (const [path, contents] of Object.entries(bundle)) {
      writeFileSync(new URL(path, directory), contents);
    }
  });
});
