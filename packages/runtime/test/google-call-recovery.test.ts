import { describe, expect, it } from 'vitest';
import { buildSessionState, type ToolHandler, type ToolName } from '@waldo/contracts';
import { b64url, googleClient } from '../src/connectors/google';
import { inMemoryToolOutputStore } from '../src/conversation/tool-output-store';
import { sanitise } from '../src/scribe/sanitiser';
import { dispatchTool, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { googleHandlers } from '../src/tools/live/google';

// A Google call that fails the same way on every retry says so: a code the model does not retry, and the one step that
// would make the call work. Synthetic mail only.
const app = { clientId: 'c', clientSecret: 's', redirectUri: 'https://example.invalid' };
const message = (id: string, body: string) => ({
  id, internalDate: '1791417600000',
  payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'sender@example.test' }, { name: 'Subject', value: 'Notes' }, { name: 'Message-ID', value: `<${id}@example.test>` }], body: { data: b64url(new TextEncoder().encode(body)) } },
});
const thread = (messages: unknown[]) => googleClient(app, { refresh_token: 'r' }, (async (input: RequestInfo | URL) =>
  String(input).includes('oauth2') ? Response.json({ access_token: 'a' }) : Response.json({ messages })) as typeof fetch);
const desk = { propose: async () => 'proposal-1', proposeSendEmail: async () => 'proposal-1', record: () => {} };
const handlers = (client: ReturnType<typeof thread>) => googleHandlers({ client: async () => client }, desk, { timezone: 'UTC', now: () => new Date('2026-11-04T09:00:00Z') });
const handler = (client: ReturnType<typeof thread>, name: ToolName) => handlers(client).find(h => h.name === name)! as ToolHandler<unknown, unknown, ToolDispatcherContext>;
const ctx = {
  authenticatedUserId: 'user-1', trigger: 'user_message', hasApproval: () => true, sourceTaint: null, toolArgSourceTaint: null, sanitise,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1_700_000_000_000 }),
} as ToolDispatcherContext;
const dispatch = (client: ReturnType<typeof thread>, name: ToolName, args: Record<string, unknown>) =>
  dispatchTool({ id: 'c1', name, args }, ctx, { handlers: [handler(client, name)] });

describe('a Google call that cannot succeed on retry', () => {
  it('a body offset past the end is a fixable argument, and the fix names body_next_offset', async () => {
    const result = await dispatch(thread([message('m1', 'short note')]), 'read_thread', { thread_id: 't', body_message_id: 'm1', body_offset: 5_000 });
    expect(result).toMatchObject({ ok: false, code: 'invalid_args', error_code: 'invalid_args', retryable: false });
    expect(result.ok ? '' : result.fix).toContain('body_next_offset');
  });

  it('a message id outside the thread is not found, and the fix says how to get the ids', async () => {
    const result = await dispatch(thread([message('m1', 'short note')]), 'read_thread', { thread_id: 't', body_message_id: 'nope', body_offset: 0 });
    expect(result).toMatchObject({ ok: false, code: 'not_found', retryable: false });
    expect(result.ok ? '' : result.fix).toContain('without body_message_id');
  });

  it('a reply whose subject differs from its thread is a fixable argument, without echoing the thread\'s subject', async () => {
    const result = await dispatch(thread([message('m1', 'short note')]), 'send_email', { to: ['sam@example.test'], subject: 'Something else', body_markdown: 'Thanks,', reply_to_thread_id: 't' });
    expect(result).toMatchObject({ ok: false, code: 'invalid_args', retryable: false });
    expect(result.ok ? '' : result.fix).toContain('subject read_thread shows');
    expect(result.ok ? '' : `${result.error} ${result.fix}`).not.toContain('Notes');
  });

  it('a named account that is not the connected one is not found, and nothing else is read', async () => {
    const result = await dispatch(thread([]), 'query_calendar', { account: 'someone@example.test', include_declined: false, limit: 20 });
    expect(result).toMatchObject({ ok: false, code: 'not_found', retryable: false });
    expect(result.ok ? '' : result.fix).toContain('connect_service');
  });

  it('a passing provider failure stays transient with the generic retry step', async () => {
    const failing = googleClient(app, { refresh_token: 'r' }, (async (input: RequestInfo | URL) =>
      String(input).includes('oauth2') ? Response.json({ access_token: 'a' }) : new Response('busy', { status: 503 })) as typeof fetch);
    const result = await dispatch(failing, 'read_thread', { thread_id: 't' });
    expect(result).toMatchObject({ ok: false, code: 'transient', retryable: true, fix: 'Try the same call once more; if it fails again, tell the owner.' });
  });
});

describe('a handler\'s own fix through the dispatcher', () => {
  const failing = (result: unknown): ToolHandler<unknown, unknown, ToolDispatcherContext> => ({
    ...handler(thread([]), 'search_communication'),
    handle: async () => result as never,
  });
  const run = (result: unknown) => dispatchTool({ id: 'c1', name: 'search_communication', args: { query: 'sam' } }, ctx, { handlers: [failing(result)] });

  it('replaces the code\'s generic step and keeps its retryable flag', async () => {
    const result = await run({ ok: false, code: 'rejected', error: 'Nothing matched.', fix: 'Search by the sender instead.', source_taint: 'external' });
    expect(result).toMatchObject({ ok: false, error: 'Nothing matched.', fix: 'Search by the sender instead.', retryable: false });
  });

  it('a malformed fix makes the whole result invalid, so no unchecked text reaches the model', async () => {
    for (const fix of ['', 'x'.repeat(501), 42]) {
      const result = await run({ ok: false, code: 'rejected', error: 'Nothing matched.', fix, source_taint: 'external' });
      expect(result).toMatchObject({ ok: false, error_code: 'invalid_handler_result' });
    }
  });
});

describe('Inline & Spill: the view shown for a result too long to show', () => {
  const big = { messages: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, body: 'lorem ipsum '.repeat(60) })) };
  const spilling = (spill: (data: unknown) => unknown): ToolHandler<unknown, unknown, ToolDispatcherContext> => ({
    ...handler(thread([]), 'search_communication'),
    handle: async () => ({ ok: true, data: big, source_taint: 'external' }) as never,
    spill,
  });
  const run = async (spill: (data: unknown) => unknown) => {
    const result = await dispatchTool({ id: 'c1', name: 'search_communication', args: { query: 'sam' } }, ctx, { handlers: [spilling(spill)], offload: inMemoryToolOutputStore() });
    return (result as { data: { head?: string; inline?: unknown; stored_output: string } }).data;
  };

  it('shows the handler\'s view in place of the raw head', async () => {
    const shown = await run((data) => ({ ids: (data as typeof big).messages.map((m) => m.id) }));
    expect(shown.inline).toEqual({ ids: big.messages.map((m) => m.id) });
    expect(shown.head).toBeUndefined();
    expect(shown.stored_output).toBeTruthy();
  });

  it('falls back to the raw head when the view throws or is no summary', async () => {
    for (const spill of [() => { throw new Error('reshaped'); }, () => ({ all: 'x'.repeat(9_000) })]) {
      const shown = await run(spill);
      expect(shown.inline).toBeUndefined();
      expect(shown.head).toMatch(/^\{"messages":/);
    }
  });

  it('withholds a secret in the view as the store does', async () => {
    const shown = await run(() => ({ note: `token ${'1111111111111111'}` }));
    expect(JSON.stringify(shown)).not.toContain('1111111111111111');
  });
});
