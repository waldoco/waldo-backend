import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildResponsibilityObligationContextV04Bundle,
  canonicalizeDeclaredOutcomeAcceptanceCriteriaV04ForDigest,
  outcomeObligationContextV04Schema,
} from '../packages/contracts/src';

describe('generate responsibility obligation context v0.4 fixtures', () => {
  it('writes the version-pinned fixture bundle', () => {
    const directory = new URL(
      '../packages/contracts/fixtures/responsibility-obligation-context/v0.4/',
      import.meta.url,
    );
    mkdirSync(directory, { recursive: true });
    const bundle = buildResponsibilityObligationContextV04Bundle((value) =>
      createHash('sha256').update(value).digest('hex'));
    const context = outcomeObligationContextV04Schema.parse(
      JSON.parse(bundle['obligation-context-confirmed.valid.json']!),
    );
    if (context.acceptanceCriteria.state !== 'confirmed') {
      throw new Error('generated declared fixture must retain declared criteria');
    }
    expect(context.acceptanceCriteria.digest).toBe(
      `sha256:${createHash('sha256')
        .update(canonicalizeDeclaredOutcomeAcceptanceCriteriaV04ForDigest(context))
        .digest('hex')}`,
    );
    for (const [path, contents] of Object.entries(bundle)) {
      writeFileSync(new URL(path, directory), contents);
    }
  });
});
