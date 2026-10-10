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

// Example exchanges for each host route (fictional identifiers; responses are what the backend returns).
const B = 'imb_' + '1'.repeat(32), A = 'ima_' + '2'.repeat(32), hostKey = 'c'.repeat(64);
const sign = (body, atMs, nonce) => {
  const head = JSON.stringify([1, B, A, atMs, nonce]) + '\n';
  return { version: 1, bridgeId: B, accountId: A, atMs, nonce, signature: createHmac('sha256', hostKey).update(Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(body, 'utf8')])).digest('hex') };
};
const ex = (path, bodyObject, atMs, nonce, response) => { const body = JSON.stringify(bodyObject); return { path, headers: { 'content-type': 'application/json', 'x-waldo-imessage-s2': JSON.stringify(sign(body, atMs, nonce)) }, body, response }; };
const event = { version: 1, bridgeId: B, accountId: A, eventId: 'example-event-1', cursor: { databaseGeneration: 'example-generation', value: '1' }, occurredAt: '2026-10-10T10:00:00Z', service: 'iMessage',
  senderHandle: 'owner@example.invalid', chatGuid: 'iMessage;-;owner@example.invalid', participants: ['owner@example.invalid'], isGroup: false, isFromMe: false, messageGuid: 'example-guid-1', partIndex: 0, kind: 'message', text: 'Hello Waldo', attachments: [] };
const exampleCommand = JSON.stringify({ version: 1, commandId: 'wrc_example', ownerId: '00000000-0000-4000-8000-000000000001', binding: { ownerId: '00000000-0000-4000-8000-000000000001', presenceId: '00000000-0000-4000-8000-000000000002', subject: 'owner@example.invalid', bridgeId: B, accountId: A, chatGuid: 'iMessage;-;owner@example.invalid', verified: true, conversationKind: 'direct', service: 'iMessage' },
  target: { bridgeId: B, accountId: A, chatGuid: 'iMessage;-;owner@example.invalid' }, service: 'iMessage', allowSMSFallback: false, operation: 'send', text: 'Hi, here is your answer.', attachments: [] });
const exampleDigest = sha(exampleCommand), deliveryId = '00000000-0000-4000-8000-0000000000d1', expiresAtMs = 1760090430000;
const commitmentSig = createHmac('sha256', hostKey).update(JSON.stringify(['waldo-imessage-http-v1:commitment', 1, B, A, deliveryId, 'wrc_example', exampleDigest, expiresAtMs]), 'utf8').digest('hex');
const examples = {
  note: 'Fictional identifiers and key (hostKey). Bodies are the exact raw bytes; signatures are computed over them.',
  hostKey,
  redeem: { path: '/channels/imessage/v1/pair/redeem', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, code: 'wim_' + 'e'.repeat(48), hostVersion: 'example-host-1', transportVersion: 'waldo-imessage-http-v1', databaseGeneration: 'example-generation' }),
    response: { status: 200, body: { version: 1, state: 'pending_verification', bridgeId: B, accountId: A, credential: { kind: 'hmac-sha256', key: hostKey }, expiresAtMs: 1760090400000 } } },
  heartbeat: ex('/channels/imessage/v1/heartbeat', { version: 1, bridgeId: B, accountId: A, databaseGeneration: 'example-generation', status: 'online' }, 1760090000000, 'example-nonce-1', { status: 200, body: { version: 1, accepted: true } }),
  event: ex('/channels/imessage/v1/events', event, 1760090001000, 'example-nonce-2', { status: 200, body: { admitted: true, eventId: 'example-event-1', digest: sha(JSON.stringify(event)) } }),
  pull: ex('/channels/imessage/v1/commands/pull', { version: 1, bridgeId: B, accountId: A }, 1760090002000, 'example-nonce-3', { status: 200, body: { version: 1, delivery: { deliveryId, attempt: 1, body: exampleCommand, headers: sign(exampleCommand, 1760090000500, 'cloud-nonce-1'), commitment: { version: 1, commandDigest: exampleDigest, expiresAtMs, signature: commitmentSig } } } }),
  result: ex('/channels/imessage/v1/commands/result', { version: 1, bridgeId: B, accountId: A, deliveryId, commandId: 'wrc_example', commandDigest: exampleDigest,
    result: { version: 1, commandId: 'wrc_example', target: { bridgeId: B, accountId: A, chatGuid: 'iMessage;-;owner@example.invalid' }, state: 'local_recorded', messageGuid: 'example-sent-guid', evidence: { kind: 'local_database', reference: 'example-row' } } },
    1760090003000, 'example-nonce-4', { status: 200, body: { version: 1, accepted: true } }),
  errors: { unauthenticated: { status: 401, body: { error: 'invalid_request' } }, conflict: { status: 409, body: { error: 'event_conflict' } }, tooLarge: { status: 413, body: { error: 'request_too_large' } } },
};
writeFileSync(new URL('./http-examples.json', import.meta.url), JSON.stringify(examples, null, 2) + '\n');
console.log('wrote vectors.json and http-examples.json');
