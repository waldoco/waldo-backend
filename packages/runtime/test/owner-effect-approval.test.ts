import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { sha256Hex, type GoogleClient } from '../src/connectors/google';
import { ownerEffectLedger, ownerEffectOperationRef } from '../src/channels/owner-effect-ledger';

it('approved send persists intent, blocks concurrent callbacks, and stores provider receipt', async () => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('effect-approved-send'));
  await runInDurableObject(stub, async (_instance, state) => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let sends = 0;
    const effects = ownerEffectLedger(state.storage, () => 1000);
    const client = { sendRaw: async () => { sends++; expect(effects.get('approval:pone:apply')?.state).toBe('attempting'); await wait; return { message_id: 'provider-id' }; }, findSentByMessageId: async (messageId: string) => { expect(messageId).toBe('<fixture@waldo-send>'); return { message_id: 'provider-id', thread_id: 'sent-thread', rfc822_message_id: '<fixture@waldo-send>', label_ids: ['SENT'] }; } } as unknown as GoogleClient;
    const deps = { owner: 42, call: async () => ({}), google: async () => client, newId: () => 'one', now: () => 1000, timezone: 'UTC', log: () => {}, effects };
    const desk = approvalDesk(state.storage.sql, deps);
    const raw = 'approved bytes';
    const id = await desk.proposeSendEmail({ to: ['friend@example.test'], subject: 'Hi', body: 'Hello', raw, digest: await sha256Hex(raw), message_id: '<fixture@waldo-send>' });
    const first = desk.decide(id, 'a', 'test');
    // Allow digest/connection awaits to finish before racing another callback.
    for (let n = 0; n < 10 && sends === 0; n++) await new Promise(resolve => setTimeout(resolve, 0));
    const second = await desk.decide(id, 'a', 'test');
    release();
    expect((await first).toast).toBe('Sent');
    expect(second.toast).toBe('Already handled.');
    expect(sends).toBe(1);
    expect(effects.get('approval:pone:apply')?.receipt?.provider_id).toBe('provider-id');
  });
});

it('restarted approved email reconciles an attempting intent without another send', async () => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('effect-approved-crash'));
  await runInDurableObject(stub, async (_instance, state) => {
    const effects = ownerEffectLedger(state.storage, () => 1000);
    let sends = 0;
    const client = { sendRaw: async () => { sends++; throw Error('response lost'); }, findSentByMessageId: async (messageId: string) => { expect(messageId).toBe('<fixture@waldo-send>'); return { message_id: 'landed-id', thread_id: 'sent-thread', rfc822_message_id: '<fixture@waldo-send>', label_ids: ['SENT'] }; } } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, { owner: 42, call: async () => ({}), google: async () => client, newId: () => 'one', now: () => 1000, timezone: 'UTC', log: () => {}, effects });
    const raw = 'bytes';
    const id = await desk.proposeSendEmail({ to: ['friend@example.test'], subject: 'Hi', body: 'Hello', raw, digest: await sha256Hex(raw), message_id: '<fixture@waldo-send>' });
    expect((await desk.decide(id, 'a', 'test')).toast).toBe('Sent');
    expect(effects.get(`approval:${id}:apply`)?.receipt?.provider_id).toBe('landed-id');
    expect(sends).toBe(1);
  });
});

it('confirmed send binds the host turn/call identity, not a model operation id', async () => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('effect-operation-ref'));
  await runInDurableObject(stub, async (_instance, state) => {
    const effects = ownerEffectLedger(state.storage, () => 1000);
    const ref = await ownerEffectOperationRef({ authenticatedUserId: 'owner', turnId: 'turn', toolCallId: 'call' });
    expect(ref).toBe(await ownerEffectOperationRef({ authenticatedUserId: 'owner', turnId: 'turn', toolCallId: 'call' }));
    expect(ref).not.toBe(await ownerEffectOperationRef({ authenticatedUserId: 'other', turnId: 'turn', toolCallId: 'call' }));
    const desk = approvalDesk(state.storage.sql, { owner: 42, call: async () => ({}), google: async () => ({ sendRaw: async () => ({ message_id: 'provider' }), findSentByMessageId: async (messageId: string) => { expect(messageId).toBe('<fixture@waldo-send>'); return { message_id: 'provider', thread_id: 'sent-thread', rfc822_message_id: '<fixture@waldo-send>', label_ids: ['SENT'] }; } } as unknown as GoogleClient), newId: () => 'one', now: () => 1000, timezone: 'UTC', log: () => {}, effects });
    const raw = 'bytes';
    const id = await desk.proposeSendEmail({ operation_ref: ref, to: ['friend@example.test'], subject: 'Hi', body: 'Hello', raw, digest: await sha256Hex(raw), message_id: '<fixture@waldo-send>' });
    expect(effects.get(`${ref}:apply`)).toBeNull();
    expect((await desk.decide(id, 'a', 'test')).toast).toBe('Sent');
    expect(effects.get(`${ref}:apply`)?.receipt?.provider_id).toBe('provider');
    expect(effects.get(`approval:${id}:apply`)).toBeNull();
  });
});


it.each(['missing SENT', 'wrong Message-ID', 'wrong thread', 'legacy search hit'] as const)('approved send remains uncertain with %s evidence and replay never resends', async fault => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`effect-send-evidence-${fault}`));
  await runInDurableObject(stub, async (_instance, state) => {
    const effects = ownerEffectLedger(state.storage, () => 1000);
    let sends = 0;
    const evidence = { message_id: 'provider', thread_id: 'intended-thread', rfc822_message_id: '<fixture@waldo-send>', label_ids: ['SENT'] };
    if (fault === 'missing SENT') evidence.label_ids = ['INBOX'];
    if (fault === 'wrong Message-ID') evidence.rfc822_message_id = '<other@waldo-send>';
    if (fault === 'wrong thread') evidence.thread_id = 'other-thread';
    const client = {
      sendRaw: async () => { sends++; return { message_id: 'provider' }; },
      findSentByMessageId: async (messageId: string, threadId?: string) => {
        expect(messageId).toBe('<fixture@waldo-send>'); expect(threadId).toBe('intended-thread');
        return fault === 'legacy search hit' ? { message_id: 'provider' } : evidence;
      },
    } as unknown as GoogleClient;
    const deps = { owner: 42, call: async () => ({}), google: async () => client, newId: () => 'one', now: () => 1000, timezone: 'UTC', log: () => {}, effects };
    const desk = approvalDesk(state.storage.sql, deps);
    const raw = 'approved bytes';
    const id = await desk.proposeSendEmail({ to: ['friend@example.test'], subject: 'Hi', body: 'Hello', raw, digest: await sha256Hex(raw), message_id: '<fixture@waldo-send>', thread_id: 'intended-thread' });
    expect((await desk.decide(id, 'a', 'test')).toast).toBe('Outcome unknown');
    expect((await approvalDesk(state.storage.sql, deps).decide(id, 'a', 'restart')).toast).toBe('Outcome unknown');
    expect(sends).toBe(1);
    expect(effects.get(`approval:${id}:apply`)?.state).toBe('unknown');
    expect(effects.get(`approval:${id}:apply`)?.receipt).toBeUndefined();
  });
});
