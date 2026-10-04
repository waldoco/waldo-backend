import { expect, it } from 'vitest';
import { devicePairingCodeHash, mintPairingCode } from '../src/devices/pairing-code';
it('mints independent canonical 256-bit codes and preserves code case', async () => {
  const one = mintPairingCode(), two = mintPairingCode();
  expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(one).not.toBe(two);
  expect(await devicePairingCodeHash('A'.repeat(43))).not.toBe(await devicePairingCodeHash('a'.repeat(43)));
});
