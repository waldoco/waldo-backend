import { describe, expect, it } from 'vitest';
import { acceptTrustedInvocation } from '@waldo/contracts';
import { localTrustedBriefScheduleInput, resolveRunLoopAdapters } from '../src/run-loop/adapters';
import { JoinedConversationPath } from '../src/conversation/joined-path';

const fixture = localTrustedBriefScheduleInput();
const accepted = acceptTrustedInvocation(fixture.admission);
if (!accepted.ok) throw new Error('fixture admission failed');
const invocation = accepted.value;
const ownerId = invocation.verified_authority.principal_ref;
const input = (id = 'user-1') => ({
  authenticatedOwnerId: ownerId,
  invocation,
  context: {
    snapshot_ref: fixture.snapshot_ref,
    snapshot_at: fixture.snapshot_at,
    canary_tokens: ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'],
    replay_context_ref: null,
  },
  userEntry: {
    id, ownerId, chatId: 'chat-1', parentId: null, threadAnchorId: null,
    surface: 'app', modelPayload: 'What is ready?', appPayload: 'What is ready?',
    modelProjection: { mode: 'include' as const },
  },
  assistantEntryId: `assistant-${id}`,
});

describe('JoinedConversationPath', () => {
  it('joins actual context composition, ACL, model call, durable publication and read-back', async () => {
    const composer = resolveRunLoopAdapters({ WALDO_ENV: 'local' }).contextComposer!;
    let observed: { system: string; messages: readonly { role: string; content: string }[]; tools: readonly string[] } | undefined;
    const publications = new Map();
    const path = new JoinedConversationPath(composer, {
      async complete(request) { observed = request; return 'Ready from Waldo.'; },
    }, undefined, publications);

    const result = await path.submit(input());
    expect(result.text).toBe('Ready from Waldo.');
    expect(result.contextRef).toMatch(/^ctx_/);
    expect(observed?.messages).toEqual([{ role: 'user', content: 'What is ready?' }]);
    expect(observed?.tools).toEqual(expect.arrayContaining(['get_crs', 'read_memory']));
    expect(observed?.system).not.toContain('0123456789abcdef');

    const reconnected = new JoinedConversationPath(composer, { async complete() { throw new Error('must not run'); } }, undefined, publications);
    expect(reconnected.read(ownerId, 'assistant-user-1')).toEqual(result);
  });

  it('applies the input window to the assembled history and reports stats to the observer', async () => {
    const composer = resolveRunLoopAdapters({ WALDO_ENV: 'local' }).contextComposer!;
    let observed: { messages: readonly { role: string; content: string }[] } | undefined;
    const statsSeen: { kept: number; dropped: number; estimated_tokens: number; budget_tokens: number }[] = [];
    const path = new JoinedConversationPath(composer, {
      async complete(request) { observed = request; return 'Noted.'; },
    }, undefined, undefined, { onWindow: (stats) => statsSeen.push(stats) });

    const first = input('user-w1');
    await path.submit(first);
    const second = input('user-w2');
    await path.submit({ ...second, userEntry: { ...second.userEntry, parentId: 'assistant-user-w1' } });

    expect(statsSeen).toHaveLength(2);
    expect(statsSeen[0]).toMatchObject({ kept: 1, dropped: 0, budget_tokens: 100_000 });
    // Second submit: full ancestor path (user1, assistant1, user2) fits, nothing dropped.
    expect(statsSeen[1]).toMatchObject({ kept: 3, dropped: 0 });
    expect(observed?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('fails closed before composition on authenticated-owner mismatch', async () => {
    const composer = resolveRunLoopAdapters({ WALDO_ENV: 'local' }).contextComposer!;
    const path = new JoinedConversationPath(composer, { async complete() { return 'no'; } });
    await expect(path.submit({ ...input(), authenticatedOwnerId: 'other' })).rejects.toThrow('authentication mismatch');
  });

  it('replays a durable publication without another model effect', async () => {
    const composer = resolveRunLoopAdapters({ WALDO_ENV: 'local' }).contextComposer!;
    let calls = 0;
    const path = new JoinedConversationPath(composer, { async complete() { calls += 1; return 'reply'; } });
    expect(await path.submit(input())).toEqual(await path.submit(input()));
    expect(calls).toBe(1);
  });

  it('cannot replay a prior publication for changed input or another conversation', async () => {
    const composer = resolveRunLoopAdapters({ WALDO_ENV: 'local' }).contextComposer!;
    let calls = 0;
    const path = new JoinedConversationPath(composer, { async complete() { calls += 1; return 'reply'; } });
    const request = input();
    await path.submit(request);
    await expect(path.submit({ ...request, userEntry: { ...request.userEntry, modelPayload: 'Changed input' } })).rejects.toThrow('input conflict');
    await expect(path.submit({ ...input('other-user'), assistantEntryId: request.assistantEntryId })).rejects.toThrow('publication identity conflict');
    expect(calls).toBe(1);
  });
});
