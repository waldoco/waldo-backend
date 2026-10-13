import { expect, it } from 'vitest';
import fixture from '../../../docs/contracts/waldo-device-bridge-v0.3.0.vectors.json';
import { canonicalJson, parseStrictJson } from '../src/devices/canonical-json';
import { frameSignatureBase, httpSignatureBase, sha256Hex, verifyEd25519 } from '../src/devices/signing';

it.each(fixture.vectors)('verifies shared v0.3.0 vector $name', async v => {
  expect(await sha256Hex(new TextEncoder().encode(v.canonical))).toBe(v.digest);
  if (v.canonical) expect(canonicalJson(parseStrictJson(new TextEncoder().encode(v.canonical), false))).toBe(v.canonical);
  if (v.signature) {
    const frame = v.canonical ? JSON.parse(v.canonical) : null;
    const base = v.surface === 'http'
      ? httpSignatureBase(String(fixture.timestamp), fixture.nonce, v.method, v.path, v.digest)
      : frameSignatureBase(frame.timestamp, frame.type, frame.message_id, frame.nonce, v.digest);
    expect(base).toBe(v.base);
    expect(await verifyEd25519(fixture.public_key, v.signature, base)).toBe(true);
    expect(await verifyEd25519(fixture.public_key, v.signature, base + 'x')).toBe(false);
  }
  expect(new TextEncoder().encode(v.wire).length).toBeLessThanOrEqual(8192);
});
