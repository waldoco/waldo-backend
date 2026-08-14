import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const root = fileURLToPath(new URL('../../', import.meta.url));
const directories = [
  'packages/contracts/fixtures/responsibility-handshake/v0.1',
  'packages/contracts/fixtures/responsibility-handshake/v0.2',
  'packages/contracts/fixtures/responsibility-planning-turn/v0.3',
];
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}
describe('released responsibility fixtures v0.1-v0.3', () => {
  it('remain byte-for-byte identical to the B1 base inventory', () => {
    const inventory = directories
      .flatMap((directory) => files(join(root, directory)))
      .sort()
      .map(
        (path) =>
          `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${relative(root, path)}\n`,
      )
      .join('');
    expect(createHash('sha256').update(inventory).digest('hex')).toBe(
      'c38c947b1c8b2d070683efd181c800b0709833b1eb4f46edf7f3a50771c2866a',
    );
  });
});
