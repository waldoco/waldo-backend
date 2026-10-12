import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { dayPlanBook } from '../src/channels/day-cards';
import { standingOrderBook } from '../src/channels/standing-orders';
import { Scheduler } from '../src/scheduler/multiplexer';

// A blocked send (unlinked or rebound owner) makes the Telegram caller return undefined instead of a message.
// Background producers must not record that as sent, completed or folded.
const fixture = vi.hoisted(() => ({ sends: 0, blocked: true }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number }) => {
    if (method !== 'sendMessage') return true;
    fixture.sends++;
    return fixture.blocked ? undefined : { message_id: 91, chat: { id: payload.chat_id } };
  } };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const name = request.request.response_format?.name;
    const text = name === 'task_source_scope' ? '{"decision":"retain","sources":[]}'
      : name === 'claim_ops' ? JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [] })
      : 'Synthetic card text.';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

it.each([['card', true], ['order', true], ['card', false], ['order', false]] as const)('background send settlement: %s, blocked=%s', async (kind, blocked) => {
  const name = `blocked-send-${kind}-${blocked}`;
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    const at = Date.parse('2026-10-03T08:05:00Z');
    Date.now = () => at;
    try {
      const owner = new TelegramOwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC' });
      state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
      await owner.alarm();
      state.storage.sql.exec('DELETE FROM schedule');
      fixture.sends = 0; fixture.blocked = blocked;
      const scheduler = new Scheduler(state.storage.sql, state.storage, { now: () => at, newRunId: () => 'r', newOutboxId: () => 'o', sha256Hex: async () => 's' });
      if (kind === 'card') await scheduler.schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: at - 300_000, dueAt: at - 300_000 });
      else await standingOrderBook(state.storage.sql, scheduler, { timezone: 'UTC', now: () => new Date(at - 6 * 3600_000) }, () => 'fixture')
        .set({ scope: 'Synthetic daily check', trigger: 'daily', at: '08:00', gate: 'notify_only', escalation: 'none' } as never);
      state.storage.kv.put('owner_alarm_last_v1', 0);
      await owner.alarm();
      expect(fixture.sends).toBeGreaterThan(0);
      if (kind === 'card') expect(dayPlanBook(state.storage.sql).read('2026-10-03').find(row => row.card === 'card:brief')?.sent).toBe(!blocked);
      else expect(state.storage.sql.exec("SELECT status FROM background_runs WHERE kind = 'standing_order'").toArray()).toEqual([{ status: blocked ? 'failed' : 'completed' }]);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
});
