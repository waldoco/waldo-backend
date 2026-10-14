// A Telegram owner turn runs for minutes, like an app or iMessage turn, and still ends inside the alarm handler that runs it.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { RUN_CLOSE_MARGIN_MS, toolRoundsFor, TOOL_ROUNDS_CEILING, turnDeadlineFor } from '../src/llm/time-budget';

vi.mock('openai', () => ({ default: class {
  responses = { create: async () => ({ id: 'fixture', output_text: '{}', output: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
} }));

const SUBJECT = '81301';
const ALARM_WALL_MS = 15 * 60_000;

const claimedTurn = async (name: string) => {
  let seen: { scope: RunEffectScope; at: number } | undefined;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const instance = new OwnerDO(state, {
      ...env, TELEGRAM_BOT_TOKEN: '123456:fictional-telegram-token', TELEGRAM_WEBHOOK_SECRET: 'fictional-inbox-secret', OPENAI_API_KEY: 'fictional-model-key',
    });
    const drain = instance as unknown as { drainInbox(): Promise<void>; turn(update: unknown, channel: string, durable: boolean, scope?: RunEffectScope): Promise<void> };
    vi.spyOn(drain, 'turn').mockImplementation(async (_update, _channel, _durable, scope) => { if (scope) seen = { scope, at: Date.now() }; });
    const response = await instance.fetch(new Request('https://telegram-owner/enqueue', {
      method: 'POST',
      headers: { 'x-waldo-inbox-secret': 'fictional-inbox-secret', 'x-waldo-telegram-subject': SUBJECT, 'x-waldo-do-name': name },
      body: JSON.stringify({ update_id: 7101, message: { message_id: 1, date: 1, from: { id: Number(SUBJECT), is_bot: false, first_name: 'T' }, chat: { id: Number(SUBJECT), type: 'private' }, text: 'Work through my week and draft the replies.' } }),
    }));
    expect(response.status).toBe(200);
    await drain.drainInbox();
    await state.storage.deleteAlarm();
  });
  if (!seen) throw new Error('the Telegram turn never ran under a run scope');
  return seen;
};

describe('a Telegram owner turn', () => {
  it('gets minutes to work, not two', async () => {
    const { scope, at } = await claimedTurn('telegram-turn-window');
    const turnTime = turnDeadlineFor(scope, at) - at;
    expect(turnTime).toBeGreaterThanOrEqual(13 * 60_000);
    expect(toolRoundsFor(turnTime)).toBe(TOOL_ROUNDS_CEILING);
  });

  it('closes its run before the alarm handler that runs it is stopped', async () => {
    const { scope, at } = await claimedTurn('telegram-turn-ceiling');
    expect(scope.deadline - at).toBeLessThan(ALARM_WALL_MS);
    expect(scope.deadline - turnDeadlineFor(scope, at)).toBe(RUN_CLOSE_MARGIN_MS);
  });
});
