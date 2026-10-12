import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { ensureSchema } from '../src/tracer/schema';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';

vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    return { ok: true as const, data: { model: request.request.model, text: 'SKIP', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});

const directory = { SUPABASE_PROJECT_URL: 'https://directory.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture', WALDO_ROUTER_HMAC_SECRET: 'fixture' };

it.each(['missing-name', 'foreign-name', 'missing-subject', 'unlinked', 'invalid-subject', 'zero-subject', 'unsafe-subject', 'infinite-subject'])('unbound directory alarm %s retains data and transport wakes without provider setup', async mode => {
  const name = `unbound-alarm-${mode}`;
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    ensureSchema(state.storage);
    const now = Date.now();
    const originalNow = Date.now; Date.now = () => now;
    state.storage.sql.exec("INSERT INTO schedule (id,kind,occurrence_at,due_at,payload_json,status,attempts,created_at,updated_at) VALUES ('brief:sweep','pre_activity_spot',?,?, '{}','armed',0,?,?)", now, now, now, now);
    if (mode !== 'missing-name') state.storage.kv.put('do_name', mode === 'foreign-name' ? 'other-owner' : name);
    if (mode !== 'missing-subject') state.storage.kv.put('telegram_subject', mode === 'invalid-subject' ? 'abc' : mode === 'zero-subject' ? '0' : mode === 'unsafe-subject' ? '9007199254740993' : mode === 'infinite-subject' ? '9'.repeat(400) : '7');
    if (mode === 'unlinked') state.storage.kv.put('telegram_unlinked', true);
    await state.storage.put({ telegram_owner_inbox_due_v1: now + 30_000, telegram_final_outbox_due_v1: now + 60_000, telegram_link_due_v1: now + 90_000, retained_fixture: 'keep' });
    const retainedInbox = [{ id: 'retained-inbox', state: 'admitted', body: 'synthetic retained owner message' }];
    const retainedFinal = [{ id: 'retained-final', status: 'pending', payload: { chat_id: 7, text: 'synthetic retained reply' } }];
    await state.storage.put({ telegram_owner_inbox_v1: retainedInbox, telegram_final_outbox_v1: retainedFinal });
    const before = state.storage.sql.exec('SELECT * FROM schedule').toArray();
    const fetcher = vi.fn(async () => { throw new Error('unexpected provider request'); });
    vi.stubGlobal('fetch', fetcher);
    try {
      // Missing model/bot configuration deliberately proves the alarm does not construct setup.
      const owner = new TelegramOwnerDO(state, { ...env, ...directory, OPENAI_API_KEY: undefined, TELEGRAM_BOT_TOKEN: undefined });
      await owner.alarm();
      expect(fetcher).not.toHaveBeenCalled();
      expect(state.storage.sql.exec('SELECT * FROM schedule').toArray()).toEqual(before);
      expect(await state.storage.get('retained_fixture')).toBe('keep');
      expect(await state.storage.get('telegram_owner_inbox_v1')).toEqual(retainedInbox);
      expect(await state.storage.get('telegram_final_outbox_v1')).toEqual(retainedFinal);
      expect(await state.storage.getAlarm()).toBe(now + 30_000);
      await state.storage.put('telegram_owner_inbox_due_v1', null); await owner.alarm();
      expect(await state.storage.getAlarm()).toBe(now + 60_000);
      await state.storage.put('telegram_final_outbox_due_v1', null); await owner.alarm();
      expect(await state.storage.getAlarm()).toBe(now + 90_000);
      await state.storage.put('telegram_link_due_v1', now - 1); await owner.alarm();
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(now + 30_000);
      expect(await state.storage.get('telegram_link_due_v1')).toBe(now - 1);
      await state.storage.put('telegram_link_due_v1', null); await owner.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
    } finally { Date.now = originalNow; vi.unstubAllGlobals(); await state.storage.deleteAlarm(); }
  });
});

it('restoring canonical binding resumes retained scheduled dispatch and normal arming', async () => {
  const name = 'unbound-restored-owner';
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    ensureSchema(state.storage);
    const now = Date.now();
    state.storage.sql.exec("INSERT INTO schedule (id,kind,occurrence_at,due_at,payload_json,status,attempts,created_at,updated_at) VALUES ('retained-reminder','reminder',?,?, '{}','armed',0,?,?)", now, now, now, now);
    const owner = new TelegramOwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:fixture', OPENAI_API_KEY: 'fixture' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    try {
      await owner.alarm();
      expect(state.storage.sql.exec("SELECT status, attempts FROM schedule WHERE id='retained-reminder'").one()).toEqual({ status: 'armed', attempts: 0 });
      state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
      await owner.alarm();
      expect(state.storage.sql.exec("SELECT 1 FROM schedule WHERE id='retained-reminder'").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT outcome FROM schedule_runs WHERE schedule_id='retained-reminder'").one()).toEqual({ outcome: 'ok' });
      expect(state.storage.sql.exec("SELECT 1 FROM schedule WHERE kind='pre_activity_spot' AND status='armed'").toArray()).toHaveLength(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    } finally { vi.unstubAllGlobals(); await state.storage.deleteAlarm(); }
  });
});
