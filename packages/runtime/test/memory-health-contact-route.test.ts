import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { claimStore, turnMemoryPrompt } from '../src/memory/claims';
import { memoryHandlers, type MemoryToolContext } from '../src/tools/live/memory';

// Handler-level fixtures, not live clinical answers. Recall is an explicit tool read.
const AT = '2026-10-01T00:00:00.000Z';
const HEALTH_SAID = 'my HbA1c was 9.1 last week and I take metformin 500mg';
const CONTACT_SAID = 'Riya number is 98765 43210 and her email is riya@example.com';
const withMemory = async (name: string, work: (s: ReturnType<typeof setup>) => Promise<void>) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), (_i, state) => work(setup(state)));
const setup = (state: DurableObjectState) => {
  const store = claimStore(state.storage.sql, fn => state.storage.transactionSync(fn));
  const handlers = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', now: () => new Date(AT), hideHistory: async () => undefined });
  const ctx = (text: string): MemoryToolContext => ({ authenticatedUserId: 'fixture-owner', trigger: 'user_message', sourceTaint: null, toolArgSourceTaint: null, memoryTurn: { ownerId: 'fixture-owner', conversationRef: 'owner', current: { message_ref: 'tg-1', text }, recent: [] } } as unknown as MemoryToolContext);
  const call = (name: string, args: unknown, text: string) => {
    const handler = handlers.find(h => h.name === name)!;
    return handler.handle(handler.schema.parse(args), ctx(text));
  };
  return { store, call };
};

it('an owner-grounded health claim is stored by remember and read_memory returns exact values', async () => {
  await withMemory('claims-health', async ({ store, call }) => {
    const text = 'HbA1c was 9.1 last week; takes metformin 500mg';
    expect(await call('remember', { kind: 'health', text, evidence_quote: HEALTH_SAID }, HEALTH_SAID)).toMatchObject({ ok: true, data: { id: 1, status: 'stored' } });
    expect(await call('read_memory', { query: 'HbA1c', hall: 'facts' }, 'what was my HbA1c?')).toMatchObject({ ok: true, data: { claims: [{ text, evidence: HEALTH_SAID, origin: 'owner', source: 'stated', source_ref: 'owner, tg-1' }], authority: 'context_only_not_action_approval' } });
    expect(turnMemoryPrompt(store, 'unrelated')).toContain(text);
    expect(turnMemoryPrompt(store, 'HbA1c')).not.toContain('<relevant_claims>');
  });
});

it('remember rejects invented health evidence instead of downgrading and recalling it', async () => {
  await withMemory('claims-health-invented', async ({ store, call }) => {
    expect(await call('remember', { kind: 'health', text: 'HbA1c was 7.2', evidence_quote: 'my HbA1c was 7.2 last month' }, HEALTH_SAID)).toMatchObject({ ok: false, code: 'invalid_args', error: 'Evidence quote is not grounded in an owner-authored message.' });
    expect(store.allClaims()).toEqual([]);
    expect(await call('read_memory', { query: 'HbA1c' }, 'what was my HbA1c?')).toMatchObject({ ok: true, data: { claims: [] } });
    expect(turnMemoryPrompt(store, 'HbA1c')).not.toContain('7.2');
  });
});

it('an owner-grounded contact fact is stored and explicit recall returns exact values', async () => {
  await withMemory('claims-contact', async ({ call }) => {
    const text = 'Riya number is 98765 43210, email riya@example.com';
    expect(await call('remember', { kind: 'fact', text, evidence_quote: CONTACT_SAID }, CONTACT_SAID)).toMatchObject({ ok: true, data: { id: 1, status: 'stored' } });
    expect(await call('read_memory', { query: 'Riya' }, 'what is Riya number and email?')).toMatchObject({ ok: true, data: { claims: [{ text, evidence: CONTACT_SAID, origin: 'owner', source_ref: 'owner, tg-1' }] } });
  });
});

it('explicit recall preserves code-written provenance and excludes untrusted claims without prompt evidence labels', async () => {
  await withMemory('claims-labels', async ({ store, call }) => {
    for (const origin of ['owner', 'agent', undefined, 'untrusted']) store.add({ kind: 'health', text: `HbA1c was 8.8 (${origin ?? 'legacy'})`, evidence: 'owner, tg-1: "my HbA1c was 8.8"', source: origin === 'owner' ? 'stated' : 'inferred', origin, source_ref: origin === 'owner' ? 'owner, tg-1' : undefined }, AT);
    const result = await call('read_memory', { query: 'HbA1c' }, 'what was my HbA1c?');
    expect(result).toMatchObject({ ok: true, data: { claims: [expect.objectContaining({ origin: null }), expect.objectContaining({ origin: 'agent', source: 'inferred' }), expect.objectContaining({ origin: 'owner', source: 'stated', source_ref: 'owner, tg-1' })], authority: 'context_only_not_action_approval' } });
    const profile = turnMemoryPrompt(store, 'HbA1c');
    expect(profile).toContain('HbA1c was 8.8 (owner)');
    for (const origin of ['agent', 'legacy', 'untrusted']) expect(profile).not.toContain(`HbA1c was 8.8 (${origin})`);
    expect(profile).not.toContain('evidence:');
    expect(profile).not.toContain('<relevant_claims>');
  });
});
