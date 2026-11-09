import { ownerTyped } from './helpers/owner-typed';
import { describe, expect, it, vi } from 'vitest';
import { markOpenOwner, OPEN_OWNER_MARK_KEY, OwnerHeldError, openOwnerHold, verifiedOpenOwnerMark } from '../src/identity/open-owner-hold';
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
const directory = (release: unknown = true) => {
  const calls: string[] = [];
  const call = async (fn: string, message: string, args: Record<string, string>) => {
    calls.push(fn);
    expect(message).toBe(`openowner.release.${args.p_do_name}`);
    if (release instanceof Error) throw release;
    return release;
  };
  return { calls, call };
};

describe('holding an owner who joined openly', () => {
  it('an owner object without the mark is a member: never held, and never asks the directory', async () => {
    const { calls, call } = directory();
    const hold = openOwnerHold({ kv: kv(), doName: () => 'owner-a', call, agreed: () => false });
    expect(await hold.held()).toBe(false);
    expect(hold.open()).toBe(false);
    expect(calls).toEqual([]);
  });

  it('a marked owner stays held, asking nothing, until the agreements are accepted; then is released once', async () => {
    const store = kv(), { calls, call } = directory();
    let agreed = false;
    const hold = openOwnerHold({ kv: store, doName: () => 'owner-b', call, agreed: () => agreed });
    hold.mark();
    expect(await hold.held()).toBe(true);
    expect(calls).toEqual([]);
    expect(hold.open()).toBe(true);
    agreed = true;
    expect(await hold.held()).toBe(false);
    expect(await hold.held()).toBe(false);
    expect(calls).toEqual(['release_open_owner']);
    expect(store.map.get(OPEN_OWNER_MARK_KEY)).toBe('released');
    hold.mark();
    expect(store.map.get(OPEN_OWNER_MARK_KEY)).toBe('released');
    expect(hold.open()).toBe(true);
  });

  it('stays held when the release is not recorded, the directory is down, or the object has no owner name yet', async () => {
    for (const [release, name] of [[false, 'owner-c'], [new Error('directory down'), 'owner-c'], [true, undefined]] as const) {
      const store = kv(), { call } = directory(release);
      const hold = openOwnerHold({ kv: store, doName: () => name, call, agreed: () => true });
      hold.mark();
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try { expect(await hold.held()).toBe(true); } finally { quiet.mockRestore(); }
      expect(store.map.get(OPEN_OWNER_MARK_KEY)).toBe('held');
    }
  });

  it('a held refusal is a closed run, so it ends work without a retry or a reply', () => {
    expect(new OwnerHeldError()).toBeInstanceOf(ClosedRunError);
  });
});

describe('marking at sign-in', () => {
  const SECRET = 'fictional-mark-secret';
  const namespace = (status = 204) => {
    const sent: Request[] = [];
    return { sent, owners: { idFromName: (name: string) => name as unknown as DurableObjectId, get: () => ({ fetch: async (request: Request) => { sent.push(request); return new Response(null, { status }); } }) } };
  };
  it('with the flag off, asks nothing and marks nothing', async () => {
    const { sent, owners } = namespace(), state = vi.fn();
    expect(await markOpenOwner({ OPEN_SIGNUP: '0', WALDO_ROUTER_HMAC_SECRET: SECRET }, state, owners, 'owner-a')).toBe(true);
    expect(state).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
  it('marks an owner the directory says joined openly, held or released, and no member', async () => {
    for (const [answer, marks] of [['held', 1], ['released', 1], ['member', 0]] as const) {
      const { sent, owners } = namespace();
      expect(await markOpenOwner({ OPEN_SIGNUP: '1', WALDO_ROUTER_HMAC_SECRET: SECRET }, async () => answer, owners, 'owner-a')).toBe(true);
      expect(sent).toHaveLength(marks);
    }
  });
  it('fails the sign-in when the directory has no owner, the object refuses the mark, or nothing can send it', async () => {
    expect(await markOpenOwner({ OPEN_SIGNUP: '1', WALDO_ROUTER_HMAC_SECRET: SECRET }, async () => null, namespace().owners, 'owner-a')).toBe(false);
    expect(await markOpenOwner({ OPEN_SIGNUP: '1', WALDO_ROUTER_HMAC_SECRET: SECRET }, async () => 'held', namespace(500).owners, 'owner-a')).toBe(false);
    expect(await markOpenOwner({ OPEN_SIGNUP: '1' }, async () => 'held', namespace().owners, 'owner-a')).toBe(false);
    expect(await markOpenOwner({ OPEN_SIGNUP: '1', WALDO_ROUTER_HMAC_SECRET: SECRET }, undefined, namespace().owners, 'owner-a')).toBe(false);
  });
  it('the owner object takes the mark only signed by the router, for itself', async () => {
    const { sent, owners } = namespace();
    await markOpenOwner({ OPEN_SIGNUP: '1', WALDO_ROUTER_HMAC_SECRET: SECRET }, async () => 'held', owners, 'owner-a');
    const mine = (name: string) => name === 'owner-a';
    expect(await verifiedOpenOwnerMark(sent[0]!.clone(), SECRET, mine)).toBe(true);
    expect(await verifiedOpenOwnerMark(sent[0]!.clone(), 'another-secret', mine)).toBe(false);
    expect(await verifiedOpenOwnerMark(sent[0]!.clone(), SECRET, name => name === 'owner-b')).toBe(false);
    const forged = new Request(sent[0]!.url, { method: 'POST', headers: { 'x-waldo-do-name': 'owner-a', 'x-waldo-open-owner-sig': '0'.repeat(64) } });
    expect(await verifiedOpenOwnerMark(forged, SECRET, mine)).toBe(false);
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
