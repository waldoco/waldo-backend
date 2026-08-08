import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildResponsibilityEffectV04Bundle,
  canonicalizeEffectIntentV04ForDigest,
  effectIntentV04Schema,
} from '../packages/contracts/src';

describe('generate responsibility effect v0.4 fixtures', () => {
  it('writes the version-pinned fixture bundle', () => {
    const directory = new URL(
      '../packages/contracts/fixtures/responsibility-effect/v0.4/',
      import.meta.url,
    );
    mkdirSync(directory, { recursive: true });
    const bundle = buildResponsibilityEffectV04Bundle((value) =>
      createHash('sha256').update(value).digest('hex'));
    const intent = effectIntentV04Schema.parse(JSON.parse(bundle['effect-intent.valid.json']!));
    expect(intent.intentDigest).toBe(
      `sha256:${createHash('sha256')
        .update(canonicalizeEffectIntentV04ForDigest(intent))
        .digest('hex')}`,
    );
    for (const [path, contents] of Object.entries(bundle)) {
      writeFileSync(new URL(path, directory), contents);
    }
  });
});
