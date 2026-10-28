import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ownerTraceId, ownerTraceSalt, rowTraces, syncRatingScore } from '../src/observability/langfuse-scores';

const ENV = { LANGFUSE_PUBLIC_KEY: 'pk-lf-synthetic', LANGFUSE_SECRET_KEY: 'sk-lf-synthetic', LANGFUSE_BASE_URL: 'https://langfuse.test/', WALDO_ENVIRONMENT: 'staging' };
const answering = (status: (method: string) => number | 'throw') => {
  const calls: { method: string; url: string }[] = [];
  const send = async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url });
    const answer = status(init.method ?? 'GET');
    if (answer === 'throw') throw new Error('down');
    return new Response('{}', { status: answer });
  };
  return { calls, send };
};

describe('the owner trace salt', () => {
  it('is made once per owner object and kept', () => {
    const store = new Map<string, unknown>();
    const kv = { get: <T>(key: string) => store.get(key) as T | undefined, put: (key: string, value: unknown) => { store.set(key, value); } } as never;
    const salt = ownerTraceSalt(kv);
    expect(ownerTraceSalt(kv)).toBe(salt);
    expect(ownerTraceId(salt, 'app-8000000000001')).toMatch(/^[0-9a-f]{32}$/);
    expect(ownerTraceId(salt, 'app-8000000000001')).toBe(ownerTraceId(salt, 'app-8000000000001'));
    expect(ownerTraceId('another-owner', 'app-8000000000001')).not.toBe(ownerTraceId(salt, 'app-8000000000001'));
  });

  it('names the trace of one owner turn on any surface and of one scheduled occurrence, and of nothing that repeats', () => {
    const imessage = JSON.stringify(['imessage', 'bridge-1', 'account-1', 3, 'event-9']);
    for (const key of ['app-8000000000001', 'tg-12', 'whatsapp-40', imessage, 'card:brief:1793520000000', 'reminder:0b6f2c1e:1793520000000'])
      expect(ownerTraceId('salt', key), key).toMatch(/^[0-9a-f]{32}$/);
    // A key shared by unrelated work keeps a random trace id, or every such trace would be one.
    for (const key of ['telegram-unlinked', 'app-browser-cleanup', 'cost:telegram', 'connect:deliver', 'app-', 'app-12-reply', 'tg--3', 'card:brief:1:mail-followup'])
      expect(ownerTraceId('salt', key), key).toBeUndefined();
  });
});

describe('the row a rating names', () => {
  it('is an owner turn\'s reply by its own id, or a delivered row by the job that wrote it, for thirty days', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`row-traces-${crypto.randomUUID()}`)), async (_instance, state) => {
      const rows = rowTraces(state.storage.sql);
      const day = 24 * 60 * 60_000;
      expect(rows.traceKey('app-8000000000001-reply')).toBe('app-8000000000001');
      expect(rows.traceKey('tg-12-reply')).toBe('tg-12');
      expect(rows.traceKey(`${JSON.stringify(['imessage', 'b', 'a', 3, 'e'])}-reply`)).toBe(JSON.stringify(['imessage', 'b', 'a', 3, 'e']));
      expect(rows.traceKey('scheduled-0b6f')).toBeNull();
      rows.link('scheduled-0b6f', 'card:brief:1793520000000', 1_000);
      rows.link('scheduled-1c7a', 'reminder:0b6f2c1e:1793520000000', 1_000 + day);
      expect(rows.traceKey('scheduled-0b6f')).toBe('card:brief:1793520000000');
      // A row linked again keeps its first job: a delivery repeated after a lost receipt is the same delivery.
      rows.link('scheduled-0b6f', 'card:close:1793560000000', 2_000);
      expect(rows.traceKey('scheduled-0b6f')).toBe('card:brief:1793520000000');
      // Langfuse keeps a trace thirty days, so a link older than that goes with the next one made.
      rows.link('scheduled-2d8b', 'card:close:1793560000000', 1_001 + 30 * day);
      expect(rows.traceKey('scheduled-0b6f')).toBeNull();
      expect(rows.traceKey('scheduled-1c7a')).toBe('reminder:0b6f2c1e:1793520000000');
    });
  });
});

describe('erasing an owner', () => {
  // Account erase is the owner object's storage.deleteAll(); the salt goes with it, so no later id can be derived to match
  // an earlier owner's traces, and an owner re-created under the same name gets a new salt.
  it('wipes the salt with the rest of the owner object\'s storage', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`trace-salt-${crypto.randomUUID()}`)), async (_instance, state) => {
      const salt = ownerTraceSalt(state.storage.kv);
      expect(ownerTraceSalt(state.storage.kv)).toBe(salt);
      await state.storage.deleteAll();
      expect(state.storage.kv.get('langfuse_trace_salt_v1')).toBeUndefined();
      expect(ownerTraceSalt(state.storage.kv)).not.toBe(salt);
    });
  });
});

describe('a rating as a Langfuse score', () => {
  const change = { messageId: 'app-8000000000001-reply', removed: 'old-score', added: { id: 'new-score', value: 1 as const } };
  const traced = 'a'.repeat(32);

  it('does nothing when Langfuse is not configured', async () => {
    const { calls, send } = answering(() => 202);
    expect(await syncRatingScore({}, traced, change, send)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('deletes the replaced score, then creates the new one, each once', async () => {
    const { calls, send } = answering(() => 202);
    expect(await syncRatingScore(ENV, traced, change, send)).toEqual({ ok: true, code: 'scored' });
    expect(calls).toEqual([{ method: 'DELETE', url: 'https://langfuse.test/api/public/scores/old-score' }, { method: 'POST', url: 'https://langfuse.test/api/public/scores' }]);
  });

  it('reports a 207 as refused and does not retry it', async () => {
    const { calls, send } = answering(() => 207);
    expect(await syncRatingScore(ENV, traced, { ...change, removed: null }, send)).toEqual({ ok: false, code: 'http_207' });
    expect(calls).toHaveLength(1);
  });

  it('still creates the new score when the delete fails, and reports the first failure', async () => {
    const { calls, send } = answering((method) => (method === 'DELETE' ? 500 : 202));
    expect(await syncRatingScore(ENV, traced, change, send)).toEqual({ ok: false, code: 'http_500' });
    expect(calls.map((call) => call.method)).toEqual(['DELETE', 'POST']);
    const down = answering(() => 'throw');
    expect(await syncRatingScore(ENV, traced, change, down.send)).toEqual({ ok: false, code: 'transport' });
    expect(down.calls).toHaveLength(2);
  });

  it('scores nothing for a row with no trace, and still clears what it replaced', async () => {
    const { calls, send } = answering(() => 200);
    expect(await syncRatingScore(ENV, null, { ...change, messageId: 'scheduled-0b6f' }, send)).toEqual({ ok: true, code: 'unlinked' });
    expect(calls.map((call) => call.method)).toEqual(['DELETE']);
    expect(await syncRatingScore(ENV, null, { messageId: 'scheduled-0b6f', removed: 'new-score', added: null }, send)).toEqual({ ok: true, code: 'cleared' });
  });
});
