#!/usr/bin/env node
// Regenerates vectors.json with Node's crypto, independently of the Worker WebCrypto code.
// Keys and identifiers are fictional. Run: node docs/channels/imessage/fixtures/generate-vectors.mjs
import { createHash, createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const key = 'a'.repeat(64); // fictional host key; its UTF-8 string bytes are the HMAC key
const scope = { version: 1, bridgeId: 'fixture-bridge', accountId: 'fixture-account' };
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (bytes) => createHmac('sha256', key).update(bytes).digest('hex');
const s2 = (body, atMs, nonce) => {
  const head = JSON.stringify([1, scope.bridgeId, scope.accountId, atMs, nonce]) + '\n';
  return { ...scope, atMs, nonce, signature: hmac(Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(body, 'utf8')])) };
};

const heartbeat = JSON.stringify({ ...scope, databaseGeneration: 'fixture-generation', status: 'online' });
const unicode = JSON.stringify({ ...scope, note: 'héllo 👋 "quoted"\n' });
const command = '{"version":1,"commandId":"fixture-command"}';
const commandDigest = sha(command);
const commitment = { bridgeId: scope.bridgeId, accountId: scope.accountId, deliveryId: 'fixture-delivery', commandId: 'fixture-command', commandDigest, expiresAtMs: 1760100030000 };
const commitmentText = JSON.stringify(['waldo-imessage-http-v1:commitment', 1, commitment.bridgeId, commitment.accountId, commitment.deliveryId, commitment.commandId, commitment.commandDigest, commitment.expiresAtMs]);

const vectors = {
  note: 'Fictional key and identifiers. HMAC key = UTF-8 bytes of the 64-hex key string.',
  key,
  s2: [
    { name: 'heartbeat', body: heartbeat, headers: s2(heartbeat, 1760100000000, 'fixture-nonce-1') },
    { name: 'unicode-body', body: unicode, headers: s2(unicode, 1760100000001, 'fixture-nonce-2') },
    { name: 'empty-body', body: '', headers: s2('', 1760100000002, 'fixture-nonce-3') },
  ],
  commitment: { fields: commitment, signedText: commitmentText, signature: hmac(Buffer.from(commitmentText, 'utf8')), commandBody: command },
};
writeFileSync(new URL('./vectors.json', import.meta.url), JSON.stringify(vectors, null, 2) + '\n');
console.log('wrote vectors.json');
