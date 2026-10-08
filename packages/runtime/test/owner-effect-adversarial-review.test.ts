import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { sha256Hex, type GoogleClient } from '../src/connectors/google';

const base = { owner: 42, call: async () => ({}), google: async () => null, newId: () => 'one', now: () => 1000, timezone: 'UTC', log: () => {} };

it('successful production-shaped MCP callback should settle a receipt', async () => {
 const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('adv-mcp'));
 await runInDurableObject(stub, async (_, state) => {
  let calls = 0;
  const effects = ownerEffectLedger(state.storage, () => 1000);
  const desk = approvalDesk(state.storage.sql, { ...base, effects, mcpCall: async () => { calls++; return { provider_id: 'approval:mcp:apply', result: 'Result (external content, bounded): ok (protocol 2025-03-26)' }; } });
  const id = await desk.proposeMcpCall({ server: 'fixture', tool: 'mutate', args: {} });
  const result = await desk.decide(id, 'a', 'test');
  expect(calls).toBe(1);
  expect(result.toast).toBe('Done');
 });
});

it('same message idempotency key on separate approved cards must not race two sends', async () => {
 const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('adv-message-race'));
 await runInDurableObject(stub, async (_, state) => {
  let id = 0, sends = 0;
  let release!: () => void;
  const wait = new Promise<void>(r => { release = r; });
  const effects = ownerEffectLedger(state.storage, () => 1000);
  const desk = approvalDesk(state.storage.sql, { ...base, newId: () => String(++id), effects, sendMessage: async () => { sends++; await wait; return { provider_id: String(sends) }; } });
  const p = { channel: 'telegram', content: 'Hi', idempotency_key: 'same' };
  const a = await desk.proposeSendMessage({ ...p, operation_ref: 'host:a' });
  const b = await desk.proposeSendMessage({ ...p, operation_ref: 'host:b' });
  const x = desk.decide(a, 'a', 'test');
  const y = desk.decide(b, 'a', 'test');
  await Promise.resolve(); release(); await Promise.all([x, y]);
  expect(sends).toBe(1);
 });
});

it('oversized message card without an approve button must reject an approve action', async () => {
 const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('adv-message-review'));
 await runInDurableObject(stub, async (_, state) => {
  let sends = 0;
  const effects = ownerEffectLedger(state.storage, () => 1000);
  const desk = approvalDesk(state.storage.sql, { ...base, effects, sendMessage: async () => { sends++; return { provider_id: 'p' }; } });
  const id = await desk.proposeSendMessage({ channel: 'telegram', content: 'x'.repeat(4000), idempotency_key: 'long' });
  await desk.decide(id, 'a', 'test');
  expect(sends).toBe(0);
 });
});

it('browser receipt persistence failure must remain unknown, not verified', async () => {
 const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('adv-browser-settle'));
 await runInDurableObject(stub, async (_, state) => {
  const storage = { kv: { get: state.storage.kv.get.bind(state.storage.kv), list: state.storage.kv.list.bind(state.storage.kv), put: (key: string, row: { state: string }) => { if (row.state === 'done') throw Error('storage down'); state.storage.kv.put(key, row); } }, transactionSync: state.storage.transactionSync.bind(state.storage) } as unknown as DurableObjectStorage;
  const effects = ownerEffectLedger(storage, () => 1000);
  const desk = approvalDesk(state.storage.sql, { ...base, effects, browserSubmit: async () => ({ status: 'verified_with_receipt', message: 'Verified', receipt: { id: 'provider', source: 'provider', observed_at: 'now', action_digest: 'd', binding_digest: 'd' } }), browserReceiptVerified: async () => true });
  const id = await desk.proposeBrowserSubmit({ url: 'https://fixture.invalid', action: { selector: '#submit', description: 'Submit' }, binding: {}, steps: [] });
  const result = await desk.decide(id, 'a', 'test');
  expect(effects.get(`approval:${id}:apply`)?.state).toBe('attempting');
  expect(result.toast).toBe('Outcome unknown');
 });
});

it('calendar create readback must not mark a cancelled event as applied', async () => {
 const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('adv-calendar-cancelled'));
 await runInDurableObject(stub, async (_, state) => {
  const effects = ownerEffectLedger(state.storage, () => 1000);
  const start = '2026-10-08T10:00:00Z', end = '2026-10-08T11:00:00Z';
  const client = { createEvent: async () => { throw Error('response lost'); }, event: async (id: string) => ({ id, title: 'Meeting', start, end, etag: 'cancelled', status: 'cancelled' }) } as unknown as GoogleClient;
  const desk = approvalDesk(state.storage.sql, { ...base, effects, google: async () => client });
  const id = await desk.propose({ action: 'create', title: 'Meeting', start, end } as never);
  expect((await desk.decide(id, 'a', 'test')).toast).toBe('Outcome unknown');
 });
});

it('failure reserving an effect after SQL approval claim must remain recoverable', async () => {
 const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('adv-email-claim-gap'));
 await runInDurableObject(stub, async (_, state) => {
  let fail = true;
  const storage = { kv: { get: state.storage.kv.get.bind(state.storage.kv), list: state.storage.kv.list.bind(state.storage.kv), put: (key: string, row: { state: string }) => { if (row.state === 'reserved' && fail) throw Error('reservation failure'); state.storage.kv.put(key, row); } }, transactionSync: state.storage.transactionSync.bind(state.storage) } as unknown as DurableObjectStorage;
  const effects = ownerEffectLedger(storage, () => 1000);
  let sends = 0;
  const client = { sendRaw: async () => { sends++; return { message_id: 'p' }; }, findSentByMessageId: async () => false } as unknown as GoogleClient;
  const desk = approvalDesk(state.storage.sql, { ...base, effects, google: async () => client });
  const raw = 'bytes';
  const id = await desk.proposeSendEmail({ to: ['a@example.test'], subject: 'Hi', body: 'Hi', raw, digest: await sha256Hex(raw), message_id: '<id@waldo>' });
  expect((await desk.decide(id, 'a', 'test')).toast).toBe('Outcome unknown');
  expect(sends).toBe(0);
  expect(effects.get(`approval:${id}:apply`)).toBeNull();
  fail = false;
  expect((await desk.decide(id, 'a', 'test')).toast).not.toBe('Already handled.');
 });
});

it('reuse of message idempotency key with changed content must not falsely report already sent', async () => {
 const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('adv-message-changed'));
 await runInDurableObject(stub, async (_, state) => {
  let id = 0;
  const effects = ownerEffectLedger(state.storage, () => 1000);
  const desk = approvalDesk(state.storage.sql, { ...base, effects, newId: () => String(++id), sendMessage: async () => ({ provider_id: 'sent' }) });
  const a = await desk.proposeSendMessage({ channel: 'telegram', content: 'A', idempotency_key: 'same' });
  expect((await desk.decide(a, 'a', 'test')).toast).toBe('Sent');
  const b = await desk.proposeSendMessage({ channel: 'telegram', content: 'B', idempotency_key: 'same' });
  const result = await desk.decide(b, 'a', 'test');
  expect(result.toast).not.toBe('Already sent');
  expect(state.storage.sql.exec<{status:string}>('SELECT status FROM ledger WHERE id = ?', b).one().status).not.toBe('done');
 });
});

it('oversized MCP card without an approve button must reject an approve action', async () => {
 const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('adv-mcp-review'));
 await runInDurableObject(stub, async (_, state) => {
  let calls = 0;
  const effects = ownerEffectLedger(state.storage, () => 1000);
  const desk = approvalDesk(state.storage.sql, { ...base, effects, mcpCall: async () => { calls++; return { provider_id: 'p', result: 'ok' }; } });
  const id = await desk.proposeMcpCall({ server: 'fixture', tool: 'mutate', args: { content: 'x'.repeat(4000) } });
  await desk.decide(id, 'a', 'test');
  expect(calls).toBe(0);
 });
});
