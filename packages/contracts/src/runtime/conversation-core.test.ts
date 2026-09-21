import { describe, expect, it } from 'vitest';
import {
  ConversationCore,
  type ConversationProvider,
  type ConversationRequest,
} from './conversation-core';

const request = (overrides: Partial<ConversationRequest> = {}): ConversationRequest => ({
  ownerId: 'owner-a',
  key: 'key-1',
  bytes: 'hello',
  ...overrides,
});

const provider = (result: string | Error = 'reply'): ConversationProvider => ({
  async complete(input) {
    if (result instanceof Error) throw result;
    return `${result}:${input.bytes}`;
  },
});

describe('ConversationCore', () => {
  it('isolates owners even when they reuse the same key', async () => {
    const core = new ConversationCore(provider());
    expect(await core.complete(request())).toEqual({ status: 'completed', value: 'reply:hello' });
    expect(await core.complete(request({ ownerId: 'owner-b' }))).toEqual({
      status: 'completed',
      value: 'reply:hello',
    });
  });

  it('does not collide when owner and request key contain the separator', async () => {
    const core = new ConversationCore(provider());
    const first = request({ ownerId: 'owner', key: 'a\u0000b', bytes: 'first' });
    const second = request({ ownerId: 'owner\u0000a', key: 'b', bytes: 'second' });

    await expect(core.complete(first)).resolves.toEqual({
      status: 'completed',
      value: 'reply:first',
    });
    await expect(core.complete(second)).resolves.toEqual({
      status: 'completed',
      value: 'reply:second',
    });
  });

  it('replays the same key without calling the provider twice', async () => {
    let calls = 0;
    const core = new ConversationCore({
      async complete(input) {
        calls += 1;
        return input.bytes;
      },
    });
    await core.complete(request());
    expect(await core.complete(request())).toEqual({ status: 'replayed', value: 'hello' });
    expect(calls).toBe(1);
  });

  it('rejects a same-key request when the bytes change', async () => {
    const core = new ConversationCore(provider());
    await core.complete(request());
    await expect(core.complete(request({ bytes: 'changed' }))).rejects.toThrow(
      'conversation request bytes mismatch',
    );
  });

  it('admits one provider operation for concurrent same-key requests', async () => {
    let calls = 0;
    let resolve!: (value: string) => void;
    const core = new ConversationCore({
      complete: async () => {
        calls += 1;
        return new Promise<string>((done) => { resolve = done; });
      },
    });
    const first = core.complete(request());
    const second = core.complete(request());

    expect(calls).toBe(1);
    resolve('reply');
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'completed', value: 'reply' },
      { status: 'completed', value: 'reply' },
    ]);
  });

  it('does not let the provider mutate the caller request or stored bytes', async () => {
    const core = new ConversationCore({
      async complete(input) {
        (input as { bytes: string }).bytes = 'mutated';
        return 'reply';
      },
    });
    const input = request();

    await expect(core.complete(input)).resolves.toEqual({ status: 'completed', value: 'reply' });
    expect(input.bytes).toBe('hello');
    await expect(core.complete(input)).resolves.toEqual({ status: 'replayed', value: 'reply' });
  });

  it('cancels a generation and ignores its stale callback', async () => {
    let resolve!: (value: string) => void;
    const core = new ConversationCore({
      complete: () => new Promise<string>((done) => { resolve = done; }),
    });
    const pending = core.complete(request());
    const generation = core.generation('owner-a');
    core.cancel('owner-a');
    resolve('late');
    await expect(pending).resolves.toEqual({ status: 'stale' });
    expect(core.generation('owner-a')).toBe(generation + 1);
  });

  it('admits a fresh request after cancelling an in-flight request', async () => {
    const resolvers: Array<(value: string) => void> = [];
    const core = new ConversationCore({
      complete: () => new Promise<string>((resolve) => { resolvers.push(resolve); }),
    });
    const stale = core.complete(request());
    core.cancel('owner-a');
    const fresh = core.complete(request());

    expect(resolvers).toHaveLength(2);
    resolvers[0]!('late');
    resolvers[1]!('current');
    await expect(stale).resolves.toEqual({ status: 'stale' });
    await expect(fresh).resolves.toEqual({ status: 'completed', value: 'current' });
  });

  it('ignores a callback after deletion or revocation', async () => {
    for (const action of ['delete', 'revoke'] as const) {
      let resolve!: (value: string) => void;
      const core = new ConversationCore({
        complete: () => new Promise<string>((done) => { resolve = done; }),
      });
      const pending = core.complete(request());
      core[action]('owner-a');
      resolve('late');
      await expect(pending).resolves.toEqual({ status: 'stale' });
    }
  });

  it('reports provider failure without fabricating a response', async () => {
    const core = new ConversationCore(provider(new Error('provider unavailable')));
    await expect(core.complete(request())).rejects.toThrow('provider unavailable');
    expect(core.has(request())).toBe(false);
  });

  it('reuses a durable completed result after a core restart', async () => {
    const records = new Map<string, { bytes: string; value: string }>();
    await new ConversationCore(provider(), records).complete(request());
    let calls = 0;
    const restarted = new ConversationCore({
      async complete() {
        calls += 1;
        return 'unexpected';
      },
    }, records);
    await expect(restarted.complete(request())).resolves.toEqual({
      status: 'replayed',
      value: 'reply:hello',
    });
    expect(calls).toBe(0);
  });

  it('rejects malformed imported records', () => {
    expect(() => new ConversationCore(provider(), new Map([
      [JSON.stringify(['owner-a', 'key-1']), { bytes: 'hello', value: 42 }],
    ]))).toThrow('invalid conversation record');
  });
});
