import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { buildResponsibilityPlanningTurnV03Bundle } from '../packages/contracts/src/protocol/responsibility-planning-turn-v0-3-fixtures';

describe('generate responsibility planning turn v0.3 fixtures', () => {
  it('writes the version-pinned fixture bundle', () => {
    const directory = new URL(
      '../packages/contracts/fixtures/responsibility-planning-turn/v0.3/',
      import.meta.url,
    );
    mkdirSync(directory, { recursive: true });
    const bundle = buildResponsibilityPlanningTurnV03Bundle((value) =>
      createHash('sha256').update(value).digest('hex'));
    for (const [path, contents] of Object.entries(bundle)) {
      writeFileSync(new URL(path, directory), contents);
    }
  });
});
