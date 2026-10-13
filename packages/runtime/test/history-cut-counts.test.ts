import { beforeEach, expect, it, vi } from 'vitest';
import { acceptTrustedInvocation, type ConversationEntry } from '@waldo/contracts';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { localTrustedBriefScheduleInput } from '../src/run-loop/adapters';
const calls = vi.hoisted(() => ({ inputs: [] as string[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  calls.inputs.push(JSON.stringify(body));
  return { id: 'fixture', output_text: 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');

const accepted = acceptTrustedInvocation(localTrustedBriefScheduleInput().admission);
if (!accepted.ok) throw new Error('fixture admission failed');
const ownerId = accepted.value.verified_authority.principal_ref;
const HELD = 'the zebra migration plan';
const memory = (held: readonly string[] = []) => ({ incompleteTopics: () => [...held], pendingTopics: () => [], claims: () => [], allClaims: () => [], recall: () => [], nodes: () => [], edges: () => [], barriers: () => [], beginSettle: () => {}, endSettle: () => {}, settle: () => {}, sweepInterruptedSettles: () => 0 });
const history = (texts: readonly string[]): ConversationEntry[] => texts.map((text, index) => ({
  id: `h${index}${index % 2 ? '-reply' : ''}`, ownerId, chatId: 'owner', parentId: index === 0 ? null : `h${index - 1}${(index - 1) % 2 ? '-reply' : ''}`, threadAnchorId: null,
  surface: 'telegram', modelPayload: text, appPayload: text, modelProjection: { mode: 'include' }, role: index % 2 ? 'assistant' : 'user',
}));
const responder = (entries: readonly ConversationEntry[], held: readonly string[] = []) => {
  const logged: TurnLogEntry[] = [];
  const store = { load: async () => ({ entries, leafId: entries.at(-1)?.id ?? null }), save: async () => {} };
  const owner = createOwnerResponder('fixture', store as never, memory(held) as never, entry => { logged.push(entry); });
  const turn = (traceId: string, conversationRef = 'owner') => owner.respond({ traceId, conversationRef, surface: 'telegram', text: 'what next?' }, (_name, work) => work());
  const cuts = () => {
    const context = logged.filter(entry => entry.hop === 'llm_reply').at(-1)!.shape!.context!;
    return { window: context.history_cut_window, held: context.history_cut_held, cap: context.history_cut_cap, scribe: context.history_cut_scribe };
  };
  return { owner, logged, turn, cuts };
};
beforeEach(() => { calls.inputs = []; });

it('counts a history row withheld for a held topic on the reply call, and nothing else', async () => {
  const { turn, cuts } = responder(history([`tell me about ${HELD}`, 'sure', 'and the budget?', 'it is fine']), [HELD]);
  await turn('tg-held');
  expect(calls.inputs.at(-1)).not.toContain('zebra');
  expect(cuts()).toEqual({ window: 0, held: 1, cap: 0, scribe: 0 });
});

it('counts the provider item cap on a long history that fits the token window', async () => {
  const { turn, cuts } = responder(history(Array.from({ length: 1_100 }, (_value, index) => `message ${index}`)));
  await turn('tg-cap');
  expect(cuts()).toEqual({ window: 0, held: 0, cap: 77, scribe: 0 });
});

it('reports each turn its own window cut: a turn after one that dropped history reports zero', async () => {
  const long = (index: number) => `message ${index} `.repeat(20_000).slice(0, 200_000);
  const { turn, cuts } = responder(history([long(0), long(1), long(2)]));
  await turn('tg-window-1');
  expect(cuts()).toEqual({ window: 2, held: 0, cap: 0, scribe: 0 });
  await turn('tg-window-2', 'other');
  expect(cuts()).toEqual({ window: 0, held: 0, cap: 0, scribe: 0 });
});

it('keeps the window and held counts off a model call that does not carry the turn history', async () => {
  const long = (index: number) => `message ${index} `.repeat(20_000).slice(0, 200_000);
  const { owner, logged, turn, cuts } = responder(history([long(0), long(1), long(2)]));
  await turn('tg-window-plan');
  expect(cuts().window).toBe(2);
  await owner.planDay('plan-1', 'plan my day').catch(() => undefined);
  const context = logged.filter(entry => entry.hop === 'llm_day_plan').at(-1)!.shape!.context!;
  expect(context).not.toHaveProperty('history_cut_window');
  expect(context).not.toHaveProperty('history_cut_held');
});
