import { describe, expect, it } from 'vitest';
import { frameSignatureBase, httpSignatureBase, sha256Hex, verifyEd25519 } from '../src/devices/signing';

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

const additionalVectors = [
  {
    "number": 1,
    "body": "{\"command_id\":\"cmd_1\",\"contract_version\":\"0.2.3\",\"device_id\":\"dev_1\",\"idempotency_key\":\"idem_1\",\"message_id\":\"01ARZ3NDEKTSV4RRFFQ69G5FAW\",\"nonce\":\"AAECAwQFBgcICQoLDA0ODw\",\"owner_id\":\"owner_1\",\"payload\":{\"state\":\"accepted\"},\"revision\":1,\"timestamp\":1790200800,\"type\":\"ack\"}",
    "digest": "7650d9debd01414a3cc82e11e117a8faad12d59de977d37010c49bf91d66eb4f",
    "signature": "c2GwY1y5gWNCSPdf9Ufb8IIRgMGx_t9wpOi02pbKlHcC-QdOb7i7R5wp-cwmk-u2Lb-mO6ah2hugIFYflTQNBw"
  },
  {
    "number": 2,
    "body": "{\"command_id\":\"cmd_1\",\"contract_version\":\"0.2.3\",\"device_id\":\"dev_1\",\"idempotency_key\":\"idem_1\",\"message_id\":\"01ARZ3NDEKTSV4RRFFQ69G5FAX\",\"nonce\":\"AAECAwQFBgcICQoLDA0ODw\",\"owner_id\":\"owner_1\",\"payload\":{\"answer\":{\"query_id\":\"query_1\",\"query_kind\":\"session_status\",\"state\":\"idle\"},\"status\":\"answered\"},\"revision\":1,\"timestamp\":1790200800,\"type\":\"result\"}",
    "digest": "1a0b0591d76e18bcf22772e2b9bdb68d63da0e55dc671ced8397941ec657210c",
    "signature": "Ur-XO9PNQy3Kszxe7A_SJp7GssLVSKp6wkZUqEZAYHkKGon0IqbLhA-vhD1ya_o-HQQkb2wOB9Sgyyd8PWpDAA"
  },
  {
    "number": 3,
    "body": "{\"contract_version\":\"0.2.3\",\"device_id\":\"dev_1\",\"message_id\":\"01ARZ3NDEKTSV4RRFFQ69G5FAZ\",\"nonce\":\"AAECAwQFBgcICQoLDA0ODw\",\"owner_id\":\"owner_1\",\"payload\":{\"declared_capabilities\":[\"machine_state_query\",\"notify_local\"],\"outbox_depth\":0},\"timestamp\":1790200800,\"type\":\"heartbeat\"}",
    "digest": "431e3fa8304bcdca049b84a0545cd82a6b7ed1f9596f18e227adc8b9b42c931f",
    "signature": "1DzrSOApCr5iU_sTuJFozlndCY-A1EhY0XVtYGf07nP_OoW_Q8bI1a9OakAvlfJBBfBQb1NDevyyH4Q3tbWzDA"
  },
  {
    "number": 4,
    "body": "{\"code\":\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\",\"contract_version\":\"0.2.3\",\"declared_capabilities\":[\"machine_state_query\"],\"device_pubkey\":\"A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg\",\"label\":\"Café <Go> 𐀀\"}",
    "digest": "cc34011527d0ae10bad46dcc1977f79898a14b2b4b71ce25f3d7b1280bb6e00a",
    "signature": "LN1dFNztIWTdRKIPPqWtUolXKHhmGygGapStEuvsxIftaLrwwGfo9V_cED3D5T1fQufFL4cAYsKjoBTBe4PhAA"
  }
];
it.each(additionalVectors)('verifies Appendix A vector $number signed bytes', async (vector) => {
  expect(await sha256Hex(new TextEncoder().encode(vector.body))).toBe(vector.digest);
  const frame = JSON.parse(vector.body) as { timestamp: number; type: string; message_id: string; nonce: string };
  const base = vector.number === 4 ? httpSignatureBase('1790200800', nonce, 'POST', '/devices/redeem', vector.digest) : frameSignatureBase(frame.timestamp, frame.type, frame.message_id, frame.nonce, vector.digest);
  expect(await verifyEd25519(publicKey, vector.signature, base)).toBe(true);
});
