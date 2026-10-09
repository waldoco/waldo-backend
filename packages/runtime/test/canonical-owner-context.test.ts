import { expect, it } from 'vitest';
import type { ConversationEntry } from '@waldo/contracts';
import { surfaceOwnerAdmission } from '../src/identity/surface-owner-admission';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import { redactConversationEntries } from '../src/channels/conversation-store';
import { episodeSpeaker } from '../src/channels/episodes';
import type { RunEffectScope } from '../src/channels/run-effect-scope';

const owner = '11111111-2222-4333-8444-555555555555';
const scope: RunEffectScope = { runId: 'fixture-run', attempt: 'fixture-attempt', deadline: 999999,
  signal: new AbortController().signal, admit: () => {}, commit: work => work() };
const storage = () => {
  const data = new Map<string, unknown>();
  const put = (rows: Record<string, unknown>) => { Object.entries(rows).forEach(([key, value]) => data.set(key, value)); };
  return { data, get: async <T,>(key: string) => data.get(key) as T | undefined,
    list: async <T,>({ prefix }: { prefix: string }) => new Map([...data].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
    put: async (rows: Record<string, unknown>) => { put(rows); },
    kv: { get: <T,>(key: string) => data.get(key) as T | undefined, put: (key: string, value: unknown) => data.set(key, value) } };
};
const context = async (ownerId = owner, lookup?: () => Promise<{ ownerId: string; bindingRef: string; revision: string; physicalDoId: string }>) => createOwnerTurnContext(await surfaceOwnerAdmission({
  scope, lookup: lookup ?? (async () => ({ ownerId, bindingRef: 'app-session-1', revision: '7', physicalDoId: 'actual-owner-do' })),
  expectedPhysicalDoId: 'actual-owner-do', surface: 'app', subject: ownerId, occurrenceKey: 'request-1', occurredAt: 10,
  text: 'Continue the planning context.', now: () => 20,
}));
const entry = (ownerRef: string, id = 'app-owner-message', parentId: string | null = null): ConversationEntry => ({
  id, ownerId: ownerRef, chatId: `owner:${ownerRef}`, parentId, threadAnchorId: null, surface: 'app',
  modelPayload: 'Synthetic cobalt project context', appPayload: 'Synthetic cobalt project context',
  modelProjection: { mode: 'include' }, role: 'user', inputOrigin: 'owner',
});

it('durable canonical history reopens with authenticated witnesses and preserves legacy history', async () => {
  const raw = storage();
  raw.data.set('conv:0000000000', { modelPayload: 'Legacy fixture context must remain isolated' });
  const admitted = await context();
  const history = canonicalOwnerConversationStore(raw as never, admitted);
  const input = entry(admitted.invocation.verified_authority.principal_ref);
  await history.save([input], input.id, scope);
  await history.save([input], input.id, scope);
  expect(await canonicalOwnerConversationStore(raw as never, await context()).load()).toEqual({ entries: [input], leafId: input.id });
  expect(raw.data.get('conv:0000000000')).toEqual({ modelPayload: 'Legacy fixture context must remain isolated' });
  expect(await canonicalOwnerConversationStore(raw as never, await context('66666666-7777-4888-8999-aaaaaaaaaaaa')).load()).toEqual({ entries: [], leafId: null });
});

it('canonical source rows cannot load or overwrite after a witness/input conflict', async () => {
  const raw = storage(), admitted = await context();
  const history = canonicalOwnerConversationStore(raw as never, admitted);
  const input = entry(admitted.invocation.verified_authority.principal_ref);
  await history.save([input], input.id, scope);
  await expect(history.save([{ ...input, modelPayload: 'Changed input' }], input.id, scope)).rejects.toThrow('input conflict');
  const key = [...raw.data.keys()].find(key => key.includes(':conv:'))!;
  raw.data.set(key, { ...input, modelPayload: 'Unwitnessed forged text' });
  await expect(history.load()).rejects.toThrow('witness mismatch');
});

it('forgetting rewrites canonical row and witness together and remains readable after restart', async () => {
  const raw = storage(), admitted = await context();
  const history = canonicalOwnerConversationStore(raw as never, admitted);
  const input = entry(admitted.invocation.verified_authority.principal_ref);
  await history.save([input], input.id, scope);
  expect((await redactConversationEntries(raw as never, ['cobalt'], '[forgotten]', scope)).remaining).toBe(0);
  const reopened = await canonicalOwnerConversationStore(raw as never, await context()).load();
  expect(reopened.entries[0]?.modelPayload).toContain('[forgotten]');
  expect(JSON.stringify(reopened)).not.toContain('cobalt');
});

it('current session revision and physical owner binding remain authority checks', async () => {
  let revision = '7';
  const admitted = await context(owner, async () => ({ ownerId: owner, bindingRef: 'app-session-1', revision, physicalDoId: 'actual-owner-do' }));
  const history = canonicalOwnerConversationStore(storage() as never, admitted);
  revision = '8';
  await expect(history.load()).rejects.toThrow('owner admission rejected');
  await expect(context(owner, async () => ({ ownerId: owner, bindingRef: 'app-session-1', revision: '7', physicalDoId: 'another-owner-do' }))).rejects.toThrow('owner admission rejected');
});

it('episode memory learning uses stamped owner origin across app and messaging surfaces', () => {
  const ownerRef = 'prn_11111111222243338444555555555555';
  for (const surface of ['app', 'telegram', 'whatsapp', 'imessage']) {
    expect(episodeSpeaker({ ...entry(ownerRef, `${surface}-input`), surface })).toBe('owner');
    expect(episodeSpeaker({ ...entry(ownerRef, `${surface}-scheduled`), surface, inputOrigin: 'machine' })).toBe('system');
    expect(episodeSpeaker({ ...entry(ownerRef, `${surface}-output`), surface, role: 'assistant', inputOrigin: undefined })).toBe('waldo');
  }
});
