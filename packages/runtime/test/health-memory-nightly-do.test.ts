import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { NIGHTLY_ID, NIGHTLY_THROUGH_KEY } from '../src/channels/episodes';
import { setHealthMemory } from '../src/channels/health-memory';
import { claimStore, HEALTH_NOTES_OFF } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';

// The owner's health notes setting reaches the nightly pass the owner object runs: off, the model is told and no health
// note is kept; on, it is. Synthetic words only.
const SAID = 'I sleep badly after late coffee. Please keep my evenings calm.';
const asked = vi.hoisted(() => ({ inputs: [] as string[], add: null as unknown[] | null }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number }) => method === 'sendMessage' ? { message_id: 900, chat: { id: payload.chat_id } } : true };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete({ request }) {
    const nightly = request.response_format?.name === 'claim_ops';
    if (nightly) asked.inputs.push(JSON.stringify(request.messages));
    const add = asked.add ?? [
      { kind: 'health', text: 'Sleeps badly after late coffee', source: 'stated', evidence: '"I sleep badly after late coffee"', touches_forgotten: false, aliases: [], aliases_touch_forgotten: false },
      { kind: 'preference', text: 'Wants calm evenings', source: 'stated', evidence: '"Please keep my evenings calm"', touches_forgotten: false, aliases: [], aliases_touch_forgotten: false },
    ];
    const text = nightly ? JSON.stringify({ add, corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null })
      : request.response_format ? '{}' : 'Noted.';
    return { ok: true, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

it.each([['off', ['preference'], true], ['on', ['health', 'preference'], false]] as const)('with health notes %s, the nightly pass keeps %j', (setting, kinds, told) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`health-nightly-${setting}`)), async (_instance, state) => {
    const realNow = Date.now;
    let now = Date.parse('2026-10-13T05:00:00Z');
    Date.now = () => now;
    asked.inputs.length = 0;
    try {
      const build = () => new OwnerDO(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture' });
      const owner = build();
      state.storage.kv.put('do_name', `health-nightly-${setting}`); state.storage.kv.put('telegram_subject', '7');
      setHealthMemory(state.storage.kv, setting);
      const update = { update_id: 300, message: { message_id: 41, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: SAID } };
      expect((await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify(update) }))).status).toBe(200);
      for (let i = 0; i < 3; i++) { now += 61_000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); }
      state.storage.kv.put(NIGHTLY_THROUGH_KEY, now - 10_800_000);
      state.storage.sql.exec('DELETE FROM schedule');
      await new Scheduler(state.storage.sql, state.storage, productionDeps()).schedule({ id: NIGHTLY_ID, kind: 'dreaming', payloadRefs: { id: NIGHTLY_ID }, occurrenceAt: now - 1000, dueAt: now - 1000, recurrence: null });
      state.storage.kv.put('owner_alarm_last_v1', 0);
      await build().alarm();
      expect(claimStore(state.storage.sql).claims().map((claim) => claim.kind).sort()).toEqual([...kinds]);
      expect(asked.inputs.length).toBeGreaterThan(0);
      expect(asked.inputs.some((input) => input.includes(HEALTH_NOTES_OFF))).toBe(told);
    } finally { Date.now = realNow; await state.storage.deleteAlarm(); }
  }));

// The one-time migration of the old notes files runs under the same setting.
it.each([['off', ['preference'], true], ['on', ['health', 'preference'], false]] as const)('with health notes %s, the notes-file migration keeps %j', (setting, kinds, told) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`health-migration-${setting}`)), async (_instance, state) => {
    asked.inputs.length = 0;
    try {
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS core_file_revisions (file TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (file, revision))');
      state.storage.sql.exec('INSERT INTO core_file_revisions VALUES (?, ?, ?, ?, ?)', 'MEMORY_CORE', 1, SAID, 'fixture', '2026-10-01T00:00:00Z');
      const owner = new OwnerDO(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture' });
      state.storage.kv.put('do_name', `health-migration-${setting}`); state.storage.kv.put('telegram_subject', '7');
      setHealthMemory(state.storage.kv, setting);
      const update = { update_id: 301, message: { message_id: 42, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: 'hello' } };
      expect((await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify(update) }))).status).toBe(200);
      await vi.waitFor(() => expect(asked.inputs.some((input) => input.includes('Notes files to split'))).toBe(true));
      await vi.waitFor(() => expect([...new Set(claimStore(state.storage.sql).claims().map((claim) => claim.kind))].sort()).toEqual([...kinds]));
      const migration = asked.inputs.filter((input) => input.includes('Notes files to split'));
      expect(migration.some((input) => input.includes(HEALTH_NOTES_OFF))).toBe(told);
    } finally { await state.storage.deleteAlarm(); }
  }));

// Probe N7 from the gate: a reading the owner forwarded, saved by the live nightly pass on evidence of the owner's own
// request. The number is in the forwarded text alone, so it is held, whatever the evidence quotes.
it('the nightly pass holds a reading that only forwarded text carries', () =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('health-nightly-forwarded')), async (_instance, state) => {
    const realNow = Date.now;
    let now = Date.parse('2026-10-13T05:00:00Z');
    Date.now = () => now;
    asked.inputs.length = 0;
    asked.add = [{ kind: 'health', text: 'Resting HR 58 bpm', source: 'stated', evidence: '"Keep this for me please"', touches_forgotten: false, aliases: [], aliases_touch_forgotten: false }];
    try {
      const build = () => new OwnerDO(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture' });
      const owner = build();
      state.storage.kv.put('do_name', 'health-nightly-forwarded'); state.storage.kv.put('telegram_subject', '7');
      const forwarded = { update_id: 310, message: { message_id: 51, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: 'Lab report. Resting HR 58 bpm', forward_origin: { type: 'hidden_user', date: 1, sender_user_name: 'Clinic' }, forward_sender_name: 'Clinic', forward_date: 1 } };
      const request = { update_id: 311, message: { message_id: 52, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: 'Keep this for me please' } };
      for (const update of [forwarded, request]) {
        expect((await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify(update) }))).status).toBe(200);
        for (let i = 0; i < 3; i++) { now += 61_000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); }
      }
      state.storage.kv.put(NIGHTLY_THROUGH_KEY, now - 10_800_000);
      state.storage.sql.exec('DELETE FROM schedule');
      await new Scheduler(state.storage.sql, state.storage, productionDeps()).schedule({ id: NIGHTLY_ID, kind: 'dreaming', payloadRefs: { id: NIGHTLY_ID }, occurrenceAt: now - 1000, dueAt: now - 1000, recurrence: null });
      state.storage.kv.put('owner_alarm_last_v1', 0);
      await build().alarm();
      expect(asked.inputs.some((input) => input.includes('Resting HR 58 bpm'))).toBe(true);
      const memory = claimStore(state.storage.sql);
      expect(memory.claims()).toEqual([]);
      expect(memory.holds().map((hold) => [hold.kind, hold.reason])).toEqual([['health', 'numeric-health']]);
    } finally { Date.now = realNow; asked.add = null; await state.storage.deleteAlarm(); }
  }));
