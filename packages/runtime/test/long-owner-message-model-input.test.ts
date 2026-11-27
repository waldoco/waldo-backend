import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { surfaceOwnerAdmission } from '../src/identity/surface-owner-admission';
import { ownerTyped } from './helpers/owner-typed';

const seen = vi.hoisted(() => ({ bodies: [] as Array<{ instructions?: string; input?: unknown }> }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: { instructions?: string; input?: unknown }) => {
  seen.bodies.push(body);
  return { id: 'fixture', output_text: 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');

const OWNER = '5d1f8a20-6c3b-4e9a-b7d2-0e4f6a8c1b3d';
const scope = (): RunEffectScope => ({ runId: 'run-long', attempt: 'attempt-one', deadline: Date.now() + 15 * 60_000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() });
const words = (chars: number) => `Plan my week. ${'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil(chars / 45))}`.slice(0, chars);

// The reply path sends the owner's own message as the model's input, not inside the system prompt, so a bound anywhere between
// admission and the provider call would cut it here.
const turnOn = async (surface: 'app' | 'whatsapp' | 'imessage', text: string) => {
  const runScope = scope();
  const admission = await surfaceOwnerAdmission({ scope: runScope, lookup: async () => ({ ownerId: OWNER, bindingRef: 'session-a', revision: '1', physicalDoId: 'physical-do' }),
    expectedPhysicalDoId: 'physical-do', surface, subject: 'subject', occurrenceKey: `long-${surface}`, occurredAt: Date.now() - 1, text });
  const context = createOwnerTurnContext(admission);
  const logged: TurnLogEntry[] = [];
  seen.bodies = [];
  const responder = createOwnerResponder('fixture', undefined, undefined, entry => { logged.push(entry); }, { timezone: 'Asia/Kolkata', now: () => new Date('2026-11-27T05:00:00Z') }, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [], runScope, undefined, { context });
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`long-input-${surface}`)), () =>
    responder.respond(ownerTyped({ traceId: `app-long-${surface}`, conversationRef: context.conversationRef, surface: 'app', text }), (_name, work) => work()));
  return { sent: seen.bodies.map(body => JSON.stringify(body.input ?? '')).join('\n'), logged };
};

it.each(['app', 'whatsapp', 'imessage'] as const)('a 10,000-character %s message is in the model call whole', async surface => {
  const text = words(10_000);
  const { sent, logged } = await turnOn(surface, text);
  expect(logged.some(entry => entry.hop === 'llm_reply' && entry.ok !== false)).toBe(true);
  expect(sent).toContain(JSON.stringify(text).slice(1, -1));
});
