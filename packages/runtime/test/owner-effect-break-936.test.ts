import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { sha256Hex, type GoogleClient } from '../src/connectors/google';

const base = { owner: 42, call: async () => ({}), google: async () => null, timezone: 'UTC', log: () => {} };
const stubFor = (n: string) => env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(n));
const status = (state: DurableObjectState, id: string) => state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;

it('BREAK-1 pre-dispatch recovery must still honour proposal TTL (12h)', async () => {
  await runInDurableObject(stubFor('b1'), async (_, state) => {
    let t = 1000, sends = 0;
    const effects = ownerEffectLedger(state.storage, () => t);
    const desk = approvalDesk(state.storage.sql, { ...base, newId: () => 'one', now: () => t, effects, sendMessage: async () => { sends++; return { provider_id: 'p' }; } });
    const id = await desk.proposeSendMessage({ channel: 'telegram', content: 'hi', idempotency_key: 'k1' });
    // simulate crash after claim, before effect reserve
    state.storage.sql.exec("UPDATE ledger SET status='uncertain', decided_at=? WHERE id=?", t, id);
    t += 13 * 60 * 60_000;
    await desk.decide(id, 'a', 'test');
    expect(sends).toBe(0);
  });
});

it('BREAK-2 two concurrent approves while google() client is still resolving: exactly one send and final status done', async () => {
  await runInDurableObject(stubFor('b2'), async (_, state) => {
    let sends = 0;
    const effects = ownerEffectLedger(state.storage, () => 1000);
    const client = { sendRaw: async () => { sends++; await new Promise(r => setTimeout(r, 5)); return { message_id: 'm' }; }, findSentByMessageId: async (messageId: string) => { expect(messageId).toBe('<x@waldo-send>'); return { message_id: 'm', thread_id: 'sent-thread', rfc822_message_id: '<x@waldo-send>', label_ids: ['SENT'] }; } } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, { ...base, newId: () => 'one', now: () => 1000, effects, google: async () => { await new Promise(r => setTimeout(r, 2)); return client; } });
    const raw = 'bytes';
    const id = await desk.proposeSendEmail({ to: ['a@example.test'], subject: 's', body: 'b', raw, digest: await sha256Hex(raw), message_id: '<x@waldo-send>' });
    const r = await Promise.all([desk.decide(id, 'a', 't'), desk.decide(id, 'a', 't'), desk.decide(id, 'a', 't')]);
    expect(sends).toBe(1);
    expect(status(state, id)).toBe('done');
    expect(r.filter(x => x.toast === 'Outcome unknown').length).toBe(0);
  });
});

it('BREAK-3 concurrent approve of same message card (recovering path) sends once', async () => {
  await runInDurableObject(stubFor('b3'), async (_, state) => {
    let sends = 0;
    const effects = ownerEffectLedger(state.storage, () => 1000);
    const desk = approvalDesk(state.storage.sql, { ...base, newId: () => 'one', now: () => 1000, effects, sendMessage: async () => { sends++; await new Promise(r => setTimeout(r, 5)); return { provider_id: 'p' }; } });
    const id = await desk.proposeSendMessage({ channel: 'telegram', content: 'hi', idempotency_key: 'k3' });
    await Promise.all([desk.decide(id, 'a', 't'), desk.decide(id, 'a', 't')]);
    expect(sends).toBe(1);
    expect(status(state, id)).toBe('done');
  });
});

it('a failed send attempt keeps its idempotency key: a thrown provider error cannot prove nothing was sent, so an identical card is not sent again', async () => {
  await runInDurableObject(stubFor('b4'), async (_, state) => {
    let n = 0, sends = 0, id = 0;
    const effects = ownerEffectLedger(state.storage, () => 1000);
    const desk = approvalDesk(state.storage.sql, { ...base, newId: () => String(++id), now: () => 1000, effects, sendMessage: async () => { n++; if (n === 1) throw Error('401 unauthorized, nothing sent'); sends++; return { provider_id: 'p' }; } });
    const p = { channel: 'telegram', content: 'hi', idempotency_key: 'k4' };
    const a = await desk.proposeSendMessage(p); await desk.decide(a, 'a', 't');
    const b = await desk.proposeSendMessage(p); await desk.decide(b, 'a', 't');
    expect(sends).toBe(0);
  });
});

it('BREAK-5 MCP object result without provider_id must not be recorded done nor crash as a generic failure', async () => {
  await runInDurableObject(stubFor('b5'), async (_, state) => {
    let calls = 0;
    const effects = ownerEffectLedger(state.storage, () => 1000);
    const desk = approvalDesk(state.storage.sql, { ...base, newId: () => 'one', now: () => 1000, effects, mcpCall: (async () => { calls++; return { result: 'ok' }; }) as never });
    const id = await desk.proposeMcpCall({ server: 's', tool: 't', args: {} });
    const out = await desk.decide(id, 'a', 't'); console.log('B5', out.toast, status(state,id), effects.get(`approval:${id}:apply`)?.state);
    expect(effects.get(`approval:${id}:apply`)?.state).toBe('attempting'); expect(out.toast).toBe('Outcome unknown');
    expect(status(state, id)).toBe('uncertain');
    expect(effects.get(`approval:${id}:apply`)?.state).not.toBe('done');
    await desk.decide(id, 'a', 't');
    expect(calls).toBe(1);
  });
});

it('BREAK-6 review_only card cannot be approved, edited, or undone', async () => {
  await runInDurableObject(stubFor('b6'), async (_, state) => {
    let sends = 0;
    const effects = ownerEffectLedger(state.storage, () => 1000);
    const desk = approvalDesk(state.storage.sql, { ...base, newId: () => 'one', now: () => 1000, effects, google: async () => ({ sendRaw: async () => { sends++; return { message_id: 'm' }; } }) as unknown as GoogleClient });
    const raw = 'bytes';
    const id = await desk.proposeSendEmail({ to: ['a@example.test'], subject: 's', body: 'x'.repeat(20000), raw, digest: await sha256Hex(raw), message_id: '<y@waldo-send>' });
    const st = status(state, id);
    for (const a of ['a', 'e', 'u'] as const) await desk.decide(id, a, 't');
    expect(sends).toBe(0);
    expect(['review_only', 'skipped', 'open', 'card_unconfirmed']).toContain(status(state, id)); // record observed state
    expect(st).toBe('review_only');
  });
});
