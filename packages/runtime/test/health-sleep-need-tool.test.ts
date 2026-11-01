import { describe, expect, it, vi } from 'vitest';
import { setSleepNeedArgsSchema } from '@waldo/contracts';
import { sleepNeedHandler } from '../src/channels/health-log';

// set_sleep_need: the owner's stated need goes to the health plane's setting, and the model hears a word back. Every value
// here is synthetic.
const tool = (answer: unknown) => {
  const sent: string[] = [];
  const handler = sleepNeedHandler(async payload => { sent.push(payload); return answer; });
  return { sent, handle: (minutes: number | null) => handler.handle(setSleepNeedArgsSchema.parse({ minutes })) };
};

describe('set_sleep_need', () => {
  it('writes the stated need whole and answers in a word, never the figure', async () => {
    const { sent, handle } = tool({ sleep_need_minutes: 480, updated_at: '2026-03-30T08:00:00.000Z' });
    const result = await handle(480);
    expect(sent).toEqual(['{"sleep_need_minutes":480}']);
    expect(result).toEqual({ ok: true, data: { state: 'set' }, source_taint: null });
    expect(JSON.stringify(result)).not.toMatch(/[0-9]/);
  });

  it('clears it when the owner asks', async () => {
    const { sent, handle } = tool({ sleep_need_minutes: null, updated_at: '2026-03-30T08:00:00.000Z' });
    expect(await handle(null)).toEqual({ ok: true, data: { state: 'cleared' }, source_taint: null });
    expect(sent).toEqual(['{"sleep_need_minutes":null}']);
  });

  it('never says it saved what the health plane did not store', async () => {
    for (const answer of [null, { error: 'not_linked' }, { error: 'invalid_request' }, { sleep_need_minutes: 420, updated_at: '2026-03-30T08:00:00.000Z' }, { updated_at: '2026-03-30T08:00:00.000Z' }, { sleep_need_minutes: 9000 }, 'ok']) {
      const result = await tool(answer).handle(480);
      expect(result.ok, JSON.stringify(answer)).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/48|420|9000/);
    }
  });

  it('asks for a recompute once the need is saved, never when it is not, and a failed ask never fails the save', async () => {
    const asks: string[] = [];
    const saved = (answer: unknown, ask: () => Promise<void>) => sleepNeedHandler(async () => answer, ask).handle(setSleepNeedArgsSchema.parse({ minutes: 480 }));
    expect(await saved({ sleep_need_minutes: 480, updated_at: '2026-03-30T08:00:00.000Z' }, async () => { asks.push('ok'); })).toMatchObject({ ok: true });
    expect(await saved({ sleep_need_minutes: 420, updated_at: '2026-03-30T08:00:00.000Z' }, async () => { asks.push('mismatch'); })).toMatchObject({ ok: false });
    expect(asks).toEqual(['ok']);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await saved({ sleep_need_minutes: 480, updated_at: '2026-03-30T08:00:00.000Z' }, async () => { throw new Error('scheduler down'); })).toMatchObject({ ok: true, data: { state: 'set' } });
  });

  it('is offered on owner chat turns only', () => {
    const handler = sleepNeedHandler(async () => null);
    expect(handler.trigger_allowlist).toEqual(['user_message']);
    expect(handler.mutates_state).toBe(true);
  });
});

describe('the stated sleep need and memory', () => {
  it('every memory writer is told to keep no sleep-need figure, in words true whether or not the setting is offered', async () => {
    const { HEALTH_MEMORY_RULES, SLEEP_NEED_MEMORY_RULE } = await import('../src/memory/health-rules');
    const { NIGHTLY_MEMORY_INSTRUCTION, MIGRATION_INSTRUCTION } = await import('../src/memory/claims');
    expect(SLEEP_NEED_MEMORY_RULE).toMatch(/^Never keep a figure for the owner's sleep need in memory/);
    // With coaching off there is no setting, so the rule names no place the need is kept.
    expect(SLEEP_NEED_MEMORY_RULE).not.toMatch(/settings|lives in|kept in|saved/);
    for (const instruction of [NIGHTLY_MEMORY_INSTRUCTION, MIGRATION_INSTRUCTION]) expect(instruction).toContain(SLEEP_NEED_MEMORY_RULE);
    // remember's description is at the 1,024-character cap and set_sleep_need is not always offered, so in chat every owner
    // turn reads the rule in the system prompt, switch on or off, tool loaded or deferred.
    expect(HEALTH_MEMORY_RULES).not.toContain(SLEEP_NEED_MEMORY_RULE);
    const { MESSAGING_BEHAVIOR } = await import('../src/prompt/messaging-behavior');
    expect(MESSAGING_BEHAVIOR).toContain(SLEEP_NEED_MEMORY_RULE);
    expect(sleepNeedHandler(async () => null).description).toContain('never in memory');
  });
});
