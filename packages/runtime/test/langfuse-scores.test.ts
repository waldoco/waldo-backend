import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { appTurnTraceId, ownerTraceSalt, syncRatingScore } from '../src/observability/langfuse-scores';

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
  it('is made once per owner object and kept, and names only app turn traces', () => {
    const store = new Map<string, unknown>();
    const kv = { get: <T>(key: string) => store.get(key) as T | undefined, put: (key: string, value: unknown) => { store.set(key, value); } } as never;
    const salt = ownerTraceSalt(kv);
    expect(ownerTraceSalt(kv)).toBe(salt);
    expect(appTurnTraceId(salt, 'app-8000000000001')).toMatch(/^[0-9a-f]{32}$/);
    expect(appTurnTraceId(salt, 'app-8000000000001')).toBe(appTurnTraceId(salt, 'app-8000000000001'));
    expect(appTurnTraceId('another-owner', 'app-8000000000001')).not.toBe(appTurnTraceId(salt, 'app-8000000000001'));
    for (const key of ['tg-12', 'card:brief:1', 'app-', 'app-12-reply']) expect(appTurnTraceId(salt, key)).toBeUndefined();
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

  it('does nothing when Langfuse is not configured', async () => {
    const { calls, send } = answering(() => 202);
    expect(await syncRatingScore({}, 'salt', change, send)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('deletes the replaced score, then creates the new one, each once', async () => {
    const { calls, send } = answering(() => 202);
    expect(await syncRatingScore(ENV, 'salt', change, send)).toEqual({ ok: true, code: 'scored' });
    expect(calls).toEqual([{ method: 'DELETE', url: 'https://langfuse.test/api/public/scores/old-score' }, { method: 'POST', url: 'https://langfuse.test/api/public/scores' }]);
  });

  it('reports a 207 as refused and does not retry it', async () => {
    const { calls, send } = answering(() => 207);
    expect(await syncRatingScore(ENV, 'salt', { ...change, removed: null }, send)).toEqual({ ok: false, code: 'http_207' });
    expect(calls).toHaveLength(1);
  });

  it('still creates the new score when the delete fails, and reports the first failure', async () => {
    const { calls, send } = answering((method) => (method === 'DELETE' ? 500 : 202));
    expect(await syncRatingScore(ENV, 'salt', change, send)).toEqual({ ok: false, code: 'http_500' });
    expect(calls.map((call) => call.method)).toEqual(['DELETE', 'POST']);
    const down = answering(() => 'throw');
    expect(await syncRatingScore(ENV, 'salt', change, down.send)).toEqual({ ok: false, code: 'transport' });
    expect(down.calls).toHaveLength(2);
  });

  it("scores nothing for a reply that is not an app owner turn's, and still clears what it replaced", async () => {
    const { calls, send } = answering(() => 200);
    expect(await syncRatingScore(ENV, 'salt', { ...change, messageId: 'scheduled-0b6f' }, send)).toEqual({ ok: true, code: 'unlinked' });
    expect(calls.map((call) => call.method)).toEqual(['DELETE']);
    expect(await syncRatingScore(ENV, 'salt', { messageId: 'app-8000000000001-reply', removed: 'new-score', added: null }, send)).toEqual({ ok: true, code: 'cleared' });
  });
});
