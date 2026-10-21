import { ownerTyped } from './helpers/owner-typed';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { ConversationEntry } from '@waldo/contracts';
import type { ConversationStore } from '../src/channels/conversation-store';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { OwnerAdmissionError } from '../src/identity/owner-message-admission';
import { surfaceOwnerAdmission, type SurfaceOwnerBinding } from '../src/identity/surface-owner-admission';

vi.mock('openai', () => ({ default: class { responses = { create: async () =>
  ({ id: 'fixture', output_text: 'Noted.', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } }) }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');

const DO_ID = 'physical-do-1';
const LIVE: SurfaceOwnerBinding = { ownerId: '5d1f8a20-6c3b-4e9a-b7d2-0e4f6a8c1b3d', bindingRef: 'session-a', revision: '1', physicalDoId: DO_ID };

const turnRevokedDuringReplySave = async (name: string) => {
  let binding = LIVE;
  const saved: ConversationEntry[][] = [];
  const scope: RunEffectScope = { runId: 'run', attempt: 'attempt', deadline: Infinity, signal: new AbortController().signal, admit: () => undefined, commit: work => work() };
  // A frozen clock keeps every read inside the reuse window: only a check that reads afresh can see the revocation.
  const admission = await surfaceOwnerAdmission({ scope, lookup: async () => binding, expectedPhysicalDoId: DO_ID, surface: 'app',
    subject: 'subject', occurrenceKey: name, occurredAt: 999_999, text: 'hello', now: () => 1_000_000 });
  const context = createOwnerTurnContext(admission);
  const store: ConversationStore = {
    load: async () => ({ entries: [], leafId: null }),
    save: async entries => {
      saved.push([...entries]);
      if (entries.some(entry => entry.role === 'assistant')) binding = { ...LIVE, revision: '2' };
    },
  };
  const reply = runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), () =>
    createOwnerResponder('fixture', store, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [], scope, undefined, { context })
      .respond(ownerTyped({ traceId: `app-${name}`, conversationRef: context.conversationRef, surface: 'app', text: 'hello' }), (_hop, work) => work()));
  return { reply, saved };
};

it('a session revoked while the reply is saved is read afresh after the save, so no reply is returned for delivery', async () => {
  const { reply, saved } = await turnRevokedDuringReplySave('reply-fresh-after-save');
  await expect(reply).rejects.toBeInstanceOf(OwnerAdmissionError);
  expect(saved.flat().some(entry => entry.role === 'assistant')).toBe(true);
});
