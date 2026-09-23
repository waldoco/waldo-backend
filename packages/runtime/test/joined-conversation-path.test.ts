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
    let observed: { system: string; messages: readonly string[]; tools: readonly string[] } | undefined;
    const publications = new Map();
    const path = new JoinedConversationPath(composer, {
      async complete(request) { observed = request; return 'Ready from Waldo.'; },
    }, undefined, publications);

    const result = await path.submit(input());
    expect(result.text).toBe('Ready from Waldo.');
    expect(result.contextRef).toMatch(/^ctx_/);
    expect(observed?.messages).toEqual(['What is ready?']);
    expect(observed?.tools).toEqual(expect.arrayContaining(['get_crs', 'read_memory']));
    expect(observed?.system).not.toContain('0123456789abcdef');

    const reconnected = new JoinedConversationPath(composer, { async complete() { throw new Error('must not run'); } }, undefined, publications);
    expect(reconnected.read(ownerId, 'assistant-user-1')).toEqual(result);
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
});
