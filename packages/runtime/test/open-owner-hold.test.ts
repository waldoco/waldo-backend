import { ownerTyped } from './helpers/owner-typed';
import { describe, expect, it, vi } from 'vitest';
import { OPEN_OWNER_STATE_KEY, OwnerHeldError, openOwnerHold } from '../src/identity/open-owner-hold';
import { ClosedRunError } from '../src/channels/run-effect-scope';

const requests: unknown[] = [];
vi.mock('openai', () => ({
  default: class {
    responses = {
      create: async (body: unknown) => {
        requests.push(body);
        return { id: `resp_${requests.length}`, output_text: 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
      },
    };
  },
}));
const { createTelegramResponder } = await import('../src/channels/telegram-turn');

const kv = () => { const map = new Map<string, unknown>(); return { map, get: <T,>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); } }; };
const directory = (state: unknown, release = true) => {
  const calls: string[] = [];
  const call = async (fn: string, message: string, args: Record<string, string>) => {
    calls.push(fn);
    expect(message).toBe(`${fn === 'open_owner_state' ? 'openowner.state' : 'openowner.release'}.${args.p_do_name}`);
    if (state instanceof Error) throw state;
    return fn === 'open_owner_state' ? state : release;
  };
  return { calls, call };
};

describe('holding an owner who joined openly', () => {
  it('a member is asked about once and never held', async () => {
    const store = kv(), { calls, call } = directory('member');
    const hold = openOwnerHold({ kv: store, doName: () => 'owner-a', call, agreed: () => false });
    expect(await hold.held()).toBe(false);
    expect(await hold.held()).toBe(false);
    expect(calls).toEqual(['open_owner_state']);
    expect(hold.open()).toBe(false);
  });

  it('an open owner stays held, with no release asked, until the agreements are accepted; then is released once', async () => {
    const store = kv(), { calls, call } = directory('held');
    let agreed = false;
    const hold = openOwnerHold({ kv: store, doName: () => 'owner-b', call, agreed: () => agreed });
    expect(await hold.held()).toBe(true);
    expect(await hold.held()).toBe(true);
    expect(calls).toEqual(['open_owner_state']);
    expect(hold.open()).toBe(true);
    agreed = true;
    expect(await hold.held()).toBe(false);
    expect(await hold.held()).toBe(false);
    expect(calls).toEqual(['open_owner_state', 'release_open_owner']);
    expect(store.map.get(OPEN_OWNER_STATE_KEY)).toBe('released');
    expect(hold.open()).toBe(true);
  });

  it('a release the directory does not record keeps the owner held and asks again next time', async () => {
    const store = kv(), { calls, call } = directory('held', false);
    const hold = openOwnerHold({ kv: store, doName: () => 'owner-c', call, agreed: () => true });
    expect(await hold.held()).toBe(true);
    expect(await hold.held()).toBe(true);
    expect(calls).toEqual(['open_owner_state', 'release_open_owner', 'release_open_owner']);
  });

  it('holds when the directory cannot answer, or answers that no active owner has this name, and remembers nothing', async () => {
    for (const answer of [new Error('directory down'), null, 'unknown']) {
      const store = kv(), { call } = directory(answer);
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try { expect(await openOwnerHold({ kv: store, doName: () => 'owner-d', call, agreed: () => true }).held()).toBe(true); }
      finally { quiet.mockRestore(); }
      expect(store.map.has(OPEN_OWNER_STATE_KEY)).toBe(false);
    }
  });

  it('an object with no directory, or not yet bound to an owner, cannot hold an open owner', async () => {
    const { calls, call } = directory('held');
    expect(await openOwnerHold({ kv: kv(), doName: () => 'owner-e', call: null, agreed: () => false }).held()).toBe(false);
    expect(await openOwnerHold({ kv: kv(), doName: () => undefined, call, agreed: () => false }).held()).toBe(false);
    expect(calls).toEqual([]);
  });

  it('a held refusal is a closed run, so it ends work without a retry or a reply', () => {
    expect(new OwnerHeldError()).toBeInstanceOf(ClosedRunError);
  });
});

describe('a held owner reaches no model', () => {
  it('neither their own turn nor a scheduled job makes a model request', async () => {
    requests.length = 0;
    const responder = createTelegramResponder({ openaiApiKey: 'test-key', held: async () => true });
    await expect(responder.respond(ownerTyped({ updateId: 1, messageId: null, senderId: 7, chatId: 7, sentAt: null, text: 'hello' }), (_name, run) => run())).rejects.toBeInstanceOf(OwnerHeldError);
    await expect(responder.prompt('held-job-1', 7, 'Write the morning card from these facts: two meetings.', async (_hop, work) => work()))
      .rejects.toBeInstanceOf(OwnerHeldError);
    expect(requests).toEqual([]);
  });

  it('once released, the same turn reaches the model', async () => {
    requests.length = 0;
    const responder = createTelegramResponder({ openaiApiKey: 'test-key', held: async () => false });
    expect(await responder.respond(ownerTyped({ updateId: 2, messageId: null, senderId: 7, chatId: 7, sentAt: null, text: 'hello' }), (_name, run) => run())).toBe('pong');
    expect(requests).toHaveLength(1);
  });
});
