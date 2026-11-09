// Tapbacks at their own seams: the line a turn reads is never the owner's own words, and react_to_message acts only in
// the owner's own turn, whatever the tool menu offered.
import { describe, expect, it, vi } from 'vitest';
import { iMessageTurnParts } from '../src/channels/imessage/owner-runtime';
import { receivedView, renderForModel } from '../src/channels/owner-inbound-turn';
import { reactToMessageHandler } from '../src/tools/live/react-to-message';
import type { RunEffectScope } from '../src/channels/run-effect-scope';

const LINE = '[Owner reacted ❤️ to your message: "See you at six."]';

describe('the tapback line an iMessage turn reads', () => {
  it('sits beside the owner\'s words as a host note, never as their words, in the stored and the model view', () => {
    const turn = iMessageTurnParts({ updateId: 1, text: 'Thanks!', reactions: [LINE] }, null)!;
    expect(turn.parts.find(part => part.text === LINE)?.authorship).not.toBe('owner');
    const stored = receivedView(turn.parts), shown = renderForModel(turn.parts);
    for (const view of [stored, shown]) {
      const at = view.text.indexOf(LINE);
      expect(at).toBeGreaterThan(0);
      // Only the owner's own words are outside the foreign ranges, which memory and the index read as not theirs.
      expect(view.foreignRanges).toHaveLength(1);
      const [{ start, end }] = view.foreignRanges as [{ start: number; end: number }];
      expect(end).toBe(at + LINE.length);
      expect(view.text.slice(start, at).trim()).toBe('');
      expect(view.text.slice(0, start).trim()).toBe('Thanks!');
    }
  });

  it('is absent from a turn that has none, which stays its text alone', () => {
    expect(iMessageTurnParts({ updateId: 1, text: 'Thanks!' }, null)).toBeNull();
  });
});

describe('react_to_message outside the owner\'s own turn', () => {
  const scope: RunEffectScope = { runId: 'run', attempt: 'a1', deadline: Date.now() + 60_000, signal: new AbortController().signal, admit: () => undefined, commit: work => work() };
  const port = () => ({ ready: vi.fn(async () => true), freeze: vi.fn(() => 'queued' as const) });
  it.each([
    ['a machine trigger', { trigger: 'brief', ownerInitiated: true }],
    ['a turn the owner did not start', { trigger: 'user_message', ownerInitiated: false }],
    ['no owner flag', { trigger: 'user_message' }],
  ])('%s queues nothing and freezes nothing', async (_name, fields) => {
    const p = port();
    expect(await reactToMessageHandler(p).handle({ reaction: 'love' }, { ...fields, runScope: scope } as never))
      .toEqual({ ok: true, data: { queued: false, reason: 'not_owner_turn' }, source_taint: null });
    expect(p.freeze).not.toHaveBeenCalled();
  });

  it('the owner\'s own turn queues it', async () => {
    const p = port();
    expect(await reactToMessageHandler(p).handle({ reaction: 'love' }, { trigger: 'user_message', ownerInitiated: true, runScope: scope } as never))
      .toEqual({ ok: true, data: { queued: true }, source_taint: null });
    expect(p.freeze).toHaveBeenCalledWith('love', scope);
  });
});

describe('react_to_message by surface', () => {
  const scope: RunEffectScope = { runId: 'run', attempt: 'a1', deadline: Date.now() + 60_000, signal: new AbortController().signal, admit: () => undefined, commit: work => work() };
  const owner = { trigger: 'user_message', ownerInitiated: true, runScope: scope } as never;

  it('a tapback-only surface sends an emoji it has a tapback for as that tapback, and refuses any other emoji', async () => {
    const p = { ready: vi.fn(async () => true), freeze: vi.fn(() => 'queued' as const) };
    expect(await reactToMessageHandler(p).handle({ reaction: '❤️' }, owner)).toEqual({ ok: true, data: { queued: true }, source_taint: null });
    expect(p.freeze).toHaveBeenCalledWith('love', scope);
    p.freeze.mockClear();
    expect(await reactToMessageHandler(p).handle({ reaction: '🔥' }, owner)).toEqual({ ok: true, data: { queued: false, reason: 'unavailable' }, source_taint: null });
    expect(p.freeze).not.toHaveBeenCalled();
  });

  const anyEmoji = (sent = true) => ({ anyEmoji: true as const, ready: vi.fn(async () => true), freeze: vi.fn((_emoji: string, _scope: RunEffectScope, _delivery: string): 'queued' | 'conflict' => 'queued'), sendNow: vi.fn(async () => sent) });
  const queued = { ok: true, data: { queued: true }, source_taint: null };
  const unqueued = (reason: string) => ({ ok: true, data: { queued: false, reason }, source_taint: null });

  it('an any-emoji surface sends the emoji itself, and a tapback name as its emoji', async () => {
    const p = anyEmoji();
    const handler = reactToMessageHandler(p);
    expect(handler.description).toMatch(/one emoji/);
    await handler.handle({ reaction: '🎉' }, owner);
    await handler.handle({ reaction: 'laugh' }, owner);
    expect(p.freeze.mock.calls.map(([emoji, , delivery]) => [emoji, delivery])).toEqual([['🎉', 'with_reply'], ['😂', 'with_reply']]);
    expect(p.sendNow).not.toHaveBeenCalled();
  });

  it('a reaction sent now goes before the turn carries on; one that did not go is reported unqueued', async () => {
    const p = anyEmoji();
    expect(await reactToMessageHandler(p).handle({ reaction: '👀', delivery: 'now' }, owner)).toEqual(queued);
    expect(p.sendNow).toHaveBeenCalledWith(scope);
    const failed = anyEmoji(false);
    expect(await reactToMessageHandler(failed).handle({ reaction: '👀', delivery: 'now' }, owner)).toEqual(unqueued('unavailable'));
  });

  it('a reaction instead of a reply closes the turn with that emoji, and only where the loop can close on it', async () => {
    const p = anyEmoji(), closeTurn = vi.fn();
    expect(await reactToMessageHandler(p).handle({ reaction: 'love', delivery: 'instead_of_reply' }, { ...(owner as object), closeTurn } as never)).toEqual(queued);
    expect(closeTurn).toHaveBeenCalledWith('❤️');
    expect(p.sendNow).not.toHaveBeenCalled();
    const unclosable = anyEmoji();
    expect(await reactToMessageHandler(unclosable).handle({ reaction: '❤️', delivery: 'instead_of_reply' }, owner)).toEqual(unqueued('unavailable'));
    expect(unclosable.freeze).not.toHaveBeenCalled();
  });

  it('a second, different reaction in one turn is refused: nothing is sent and the turn is not closed', async () => {
    const p = anyEmoji(), closeTurn = vi.fn();
    p.freeze.mockReturnValue('conflict');
    for (const delivery of ['now', 'instead_of_reply'] as const) {
      expect(await reactToMessageHandler(p).handle({ reaction: '👍', delivery }, { ...(owner as object), closeTurn } as never)).toEqual(unqueued('already_reacted'));
    }
    expect(p.sendNow).not.toHaveBeenCalled();
    expect(closeTurn).not.toHaveBeenCalled();
  });

  it.each(['now', 'instead_of_reply'] as const)('a tapback-only surface declines delivery %s and freezes nothing, since its tapback leaves with the reply', async (delivery) => {
    const p = { ready: vi.fn(async () => true), freeze: vi.fn(() => 'queued' as const) };
    expect(await reactToMessageHandler(p).handle({ reaction: 'love', delivery }, { ...(owner as object), closeTurn: vi.fn() } as never)).toEqual(unqueued('unavailable'));
    expect(p.freeze).not.toHaveBeenCalled();
  });
});
