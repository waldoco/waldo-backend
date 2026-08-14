import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { buildResponsibilityAcceptanceCheckV04Bundle } from '../packages/contracts/src/protocol/responsibility-acceptance-check-v0-4-fixtures';

describe('generate responsibility acceptance check v0.4 fixtures', () => {
  it('writes the version-pinned fixture bundle', () => {
    const directory = new URL(
      '../packages/contracts/fixtures/responsibility-acceptance-check/v0.4/',
      import.meta.url,
    );
    mkdirSync(directory, { recursive: true });
    const bundle = buildResponsibilityAcceptanceCheckV04Bundle((value) =>
      createHash('sha256').update(value).digest('hex'),
    );
    for (const [path, contents] of Object.entries(bundle)) {
      writeFileSync(new URL(path, directory), contents);
    }
  });
});
