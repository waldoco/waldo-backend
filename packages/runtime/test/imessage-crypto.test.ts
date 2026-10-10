import { expect, it } from 'vitest';
import vectors from '../../../docs/channels/imessage/fixtures/vectors.json';
import {
  commitmentSignedText, mintHostKey, sha256Hex, signCommitment, signS2, timingSafeHexEqual, unwrapCredential, verifyCommitment, verifyS2, wrapCredential,
} from '../src/channels/imessage/crypto';

// vectors.json is produced by Node crypto (generate-vectors.mjs), independently of this WebCrypto code.
it('S2 signatures match the independent Node vectors byte for byte, including unicode and empty bodies', async () => {
  for (const v of vectors.s2) {
    const { signature, ...fields } = v.headers;
    expect((await signS2(v.body, fields as never, vectors.key)).signature).toBe(signature);
    expect(await verifyS2(v.body, v.headers as never, vectors.key)).toBe(true);
    expect(await verifyS2(v.body + ' ', v.headers as never, vectors.key)).toBe(false);
    expect(await verifyS2(v.body, { ...v.headers, nonce: 'other' } as never, vectors.key)).toBe(false);
    expect(await verifyS2(v.body, v.headers as never, 'b'.repeat(64))).toBe(false);
  }
});

it('commitment signs the exact profile-tagged text and binds every field', async () => {
  const c = vectors.commitment;
  expect(commitmentSignedText(c.fields)).toBe(c.signedText);
  expect(c.fields.commandDigest).toBe(await sha256Hex(c.commandBody));
  expect((await signCommitment(c.fields, vectors.key)).signature).toBe(c.signature);
  expect(await verifyCommitment(c.fields, c.signature, vectors.key)).toBe(true);
  for (const field of ['bridgeId', 'accountId', 'deliveryId', 'commandId', 'commandDigest'] as const)
    expect(await verifyCommitment({ ...c.fields, [field]: field === 'commandDigest' ? '0'.repeat(64) : 'other' }, c.signature, vectors.key)).toBe(false);
  expect(await verifyCommitment({ ...c.fields, expiresAtMs: c.fields.expiresAtMs + 1 }, c.signature, vectors.key)).toBe(false);
});

it('timing-safe compare refuses length, case and non-hex differences', () => {
  expect(timingSafeHexEqual('ab', 'ab')).toBe(true);
  expect(timingSafeHexEqual('ab', 'AB')).toBe(false);
  expect(timingSafeHexEqual('ab', 'abc')).toBe(false);
  expect(timingSafeHexEqual('zz', 'zz')).toBe(false);
});

it('credential wrapping is bound to environment/bridge/account/revision and the wrapping key', async () => {
  const wrapping = 'c'.repeat(64), key = mintHostKey();
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  const scope = { environment: 'test', bridgeId: 'b1', accountId: 'a1', revision: '1' };
  const sealed = await wrapCredential(key, scope, wrapping);
  expect(sealed).not.toContain(key);
  expect(await unwrapCredential(sealed, scope, wrapping)).toBe(key);
  for (const change of [{ environment: 'staging' }, { bridgeId: 'b2' }, { accountId: 'a2' }, { revision: '2' }])
    expect(await unwrapCredential(sealed, { ...scope, ...change }, wrapping)).toBeNull();
  expect(await unwrapCredential(sealed, scope, 'd'.repeat(64))).toBeNull();
  expect(await unwrapCredential('v1.garbage', scope, wrapping)).toBeNull();
  await expect(wrapCredential(key, scope, 'short')).rejects.toThrow('imessage_wrapping_key_invalid');
});
