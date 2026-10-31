import { describe, expect, it } from 'vitest';
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
    const { sent, handle } = tool({ sleep_need_minutes: 480 });
    const result = await handle(480);
    expect(sent).toEqual(['{"sleep_need_minutes":480}']);
    expect(result).toEqual({ ok: true, data: { state: 'set' }, source_taint: null });
    expect(JSON.stringify(result)).not.toMatch(/[0-9]/);
  });

  it('clears it when the owner asks', async () => {
    const { sent, handle } = tool({ sleep_need_minutes: null });
    expect(await handle(null)).toEqual({ ok: true, data: { state: 'cleared' }, source_taint: null });
    expect(sent).toEqual(['{"sleep_need_minutes":null}']);
  });

  it('never says it saved what the health plane did not store', async () => {
    for (const answer of [null, { error: 'not_linked' }, { error: 'invalid_request' }, { sleep_need_minutes: 420 }, 'ok']) {
      const result = await tool(answer).handle(480);
      expect(result.ok, JSON.stringify(answer)).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/48|420/);
    }
  });

  it('is offered on owner chat turns only', () => {
    const handler = sleepNeedHandler(async () => null);
    expect(handler.trigger_allowlist).toEqual(['user_message']);
    expect(handler.mutates_state).toBe(true);
  });
});

describe('the stated sleep need and memory', () => {
  it('every background memory writer is told the sleep need lives in the health settings, with no figure in memory', async () => {
    const { HEALTH_MEMORY_RULES, SLEEP_NEED_MEMORY_RULE } = await import('../src/memory/health-rules');
    const { NIGHTLY_MEMORY_INSTRUCTION, MIGRATION_INSTRUCTION } = await import('../src/memory/claims');
    expect(SLEEP_NEED_MEMORY_RULE).toContain('memory keeps no figure for it');
    for (const instruction of [NIGHTLY_MEMORY_INSTRUCTION, MIGRATION_INSTRUCTION]) expect(instruction).toContain(SLEEP_NEED_MEMORY_RULE);
    // remember's description is at the 1,024-character cap, so in chat the tool's own description carries it.
    expect(HEALTH_MEMORY_RULES).not.toContain(SLEEP_NEED_MEMORY_RULE);
    expect(sleepNeedHandler(async () => null).description).toContain('never in memory');
  });
});
