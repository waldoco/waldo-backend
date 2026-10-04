import { describe, expect, it } from 'vitest';
import { httpSignatureBase, sha256Hex, verifyEd25519 } from '../src/devices/signing';

// Public contract Appendix A vector 0: this key/code must never be used for live pairing.
const body = '{"code":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","contract_version":"0.2.3","declared_capabilities":["machine_state_query","notify_local"],"device_pubkey":"A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg","label":"Test Mac"}';
const publicKey = 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg';
const signature = 'VlVfMNC0TTbHKXsDsjGjWyBHnaVAMSud0b_DlEukL78UzWBdJhs_knA09uH0NSzsuFbWpLSU-xYhqKEsFGPbDw';
const digest = '90d6daa8d89edfae3a13f3584eb36cf04155539bf5c2c2ccf2f73de122ba6175';
const nonce = 'AAECAwQFBgcICQoLDA0ODw';
const expectedBase = `1790200800\n${nonce}\nPOST\n/devices/redeem\n${digest}`;

describe('device bridge signing in workerd', () => {
  it('hashes the exact Appendix A redeem bytes and constructs its LF-only base', async () => {
    expect(await sha256Hex(new TextEncoder().encode(body))).toBe(digest);
    expect(httpSignatureBase('1790200800', nonce, 'POST', '/devices/redeem', digest)).toBe(expectedBase);
    expect(expectedBase.endsWith('\n')).toBe(false);
  });

  it('verifies the normative pure Ed25519 signature using workerd WebCrypto', async () => {
    // A real verification result proves the runtime supports Ed25519, beyond digest equality.
    expect(await verifyEd25519(publicKey, signature, expectedBase)).toBe(true);
  });

  it.each([
    ['timestamp', expectedBase.replace('1790200800', '1790200801')],
    ['path', expectedBase.replace('/devices/redeem', '/devices/connect')],
    ['body', expectedBase.replace(digest, '0'.repeat(64))],
    ['trailing LF', `${expectedBase}\n`],
  ])('rejects a tampered %s', async (_field, tamperedBase) => {
    expect(await verifyEd25519(publicKey, signature, tamperedBase)).toBe(false);
  });
});
