import { describe, expect, it } from 'vitest';
import { buildSessionState, TOOL_SPILL_VIEW_MAX_CHARS, type ToolHandler, type ToolName } from '@waldo/contracts';
import { b64url, googleClient } from '../src/connectors/google';
import { inMemoryToolOutputStore } from '../src/conversation/tool-output-store';
import { sanitise } from '../src/scribe/sanitiser';
import { dispatchTool, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { googleHandlers, threadSpill } from '../src/tools/live/google';

// A Google call that fails the same way on every retry says so: a code the model does not retry, and the one step that
// would make the call work. Synthetic mail only.
const app = { clientId: 'c', clientSecret: 's', redirectUri: 'https://example.invalid' };
const message = (id: string, body: string, extra: readonly { name: string; value: string }[] = []) => ({
  id, internalDate: '1791417600000',
  payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'sender@example.test' }, { name: 'Subject', value: 'Notes' }, { name: 'Message-ID', value: `<${id}@example.test>` }, ...extra], body: { data: b64url(new TextEncoder().encode(body)) } },
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

  it('a result too long for the store says how to reach what was cut, and shows no view of it', async () => {
    const huge = { messages: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, body: 'lorem ipsum '.repeat(60) })) };
    const result = await dispatchTool({ id: 'c1', name: 'search_communication', args: { query: 'sam' } }, ctx, {
      handlers: [{ ...spilling(() => ({ ids: [] })), handle: async () => ({ ok: true, data: huge, source_taint: 'external' }) as never }], offload: inMemoryToolOutputStore(),
    });
    const shown = (result as { data: { truncated: boolean; inline?: unknown; next?: string } }).data;
    expect(shown.truncated).toBe(true);
    expect(shown.inline).toBeUndefined();
    expect(shown.next).toContain('smaller limit');
  });

  it('withholds a secret in the view as the store does', async () => {
    const shown = await run(() => ({ note: `token ${'1111111111111111'}` }));
    expect(JSON.stringify(shown)).not.toContain('1111111111111111');
  });
});

describe('the read_thread index on a long thread', () => {
  const people = (prefix: string, n: number) => Array.from({ length: n }, (_, k) => `${prefix}${k}@example.test`).join(', ');
  const longThread = (n: number, to: number, cc: number) => thread(Array.from({ length: n }, (_, i) =>
    message(`m${i}`, `message ${i} ${'lorem ipsum dolor '.repeat(200)}`, [{ name: 'To', value: people(`to${i}-`, to) }, { name: 'Cc', value: people(`cc${i}-`, cc) }])));
  const index = async (n: number, to: number, cc: number) => {
    const result = await dispatchTool({ id: 'c1', name: 'read_thread', args: { thread_id: 't', limit: n } }, ctx, { handlers: [handler(longThread(n, to, cc), 'read_thread')], offload: inMemoryToolOutputStore() });
    return (result as { data: { head?: string; inline?: { messages: { id: string; opening?: string; body_chars_here: number; body_next_offset?: number }[]; next: string } } }).data;
  };

  for (const [n, to, cc] of [[15, 1, 0], [20, 1, 0], [20, 3, 3], [10, 6, 6]] as const) {
    it(`names all ${n} messages, each with its opening or where its body starts, when every message has ${to} to and ${cc} cc`, async () => {
      const shown = await index(n, to, cc);
      expect(shown.head).toBeUndefined();
      expect(shown.inline!.messages.map((m) => m.id)).toEqual(Array.from({ length: n }, (_, i) => `m${i}`));
      // The first read shares one body budget, so a later message can arrive with none of its body yet.
      for (const [i, m] of shown.inline!.messages.entries()) {
        if (m.body_chars_here > 0) expect(m.opening).toMatch(new RegExp(`^message ${i} lorem`));
        else expect(m.body_next_offset).toBe(0);
      }
      expect(shown.inline!.messages[0]!.opening!.length).toBeGreaterThan(0);
      expect(JSON.stringify(shown.inline).length).toBeLessThanOrEqual(TOOL_SPILL_VIEW_MAX_CHARS);
    });
  }

  const at = '2026-11-04T09:00:00.000Z';
  const spillOf = (messages: readonly Record<string, unknown>[]) =>
    threadSpill({ thread_id: 't', account: null, cursor: null, messages }) as { messages: Record<string, unknown>[]; next: string };

  it('drops the openings, then the recipients, before the bodies\' positions and flags', () => {
    const wide = Array.from({ length: 5 }, (_, k) => `a-rather-long-mailbox-name-number-${k}@a-long-company-domain.example.test`);
    const messages = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, from: 'sender@example.test', at, subject: 'Notes', body: 'x'.repeat(500), to: wide, cc: wide, recipients_capped: true, body_source: 'snippet', body_next_offset: 500, body_total_chars: 900 }));
    const view = spillOf(messages);
    expect(view.messages.map((m) => m.id)).toEqual(messages.map((m) => m.id));
    expect(view.messages[0]).not.toHaveProperty('opening');
    expect(view.messages[0]).not.toHaveProperty('to');
    expect(view.messages[0]).toMatchObject({ recipients_capped: true, body_source: 'snippet', body_next_offset: 500, body_chars_here: 500 });
    expect(view.next).toContain('body_message_id');
    expect(JSON.stringify(view).length).toBeLessThanOrEqual(TOOL_SPILL_VIEW_MAX_CHARS);
  });

  it('keeps every message in view when 20 senders and subjects are each hundreds of characters long', () => {
    const name = `"${'A Very Long Display Name '.repeat(12)}" <someone@example.test>`;
    const messages = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, from: name, at, subject: 'Re: '.repeat(80) + 'Notes', body: 'x'.repeat(500) }));
    const view = spillOf(messages);
    expect(view.messages.map((m) => m.id)).toEqual(messages.map((m) => m.id));
    expect(String(view.messages[0]!.from).startsWith('"A Very Long')).toBe(true);
    expect(JSON.stringify(view).length).toBeLessThanOrEqual(TOOL_SPILL_VIEW_MAX_CHARS);
  });

  it('the last step keeps what makes a message different to read: withheld, quarantined, truncated, attachments', () => {
    const long = 'x'.repeat(300);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`, from: long, at, subject: long, body: '', recipients_capped: true, body_source: 'snippet',
      body_withheld: 'scribe_refused', quarantined: ['otp'], body_truncated: true, attachments: [{}, {}],
    }));
    const view = spillOf(messages);
    expect(view.next).toContain('id, sender, time and subject');
    expect(view.messages[0]).toMatchObject({ recipients_capped: true, body_source: 'snippet', body_withheld: 'scribe_refused', quarantined: ['otp'], body_truncated: true, attachments: 2 });
    expect(JSON.stringify(view).length).toBeLessThanOrEqual(TOOL_SPILL_VIEW_MAX_CHARS);
  });

  it('the last step cuts by escaped length, so senders and subjects full of quotes still fit', () => {
    const quoted = '"'.repeat(400);
    const messages = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, from: quoted, at, subject: quoted, body: '' }));
    const view = spillOf(messages);
    expect(view.messages.map((m) => m.id)).toEqual(messages.map((m) => m.id));
    expect(String(view.messages[0]!.from).length).toBeGreaterThan(0);
    expect(JSON.stringify(view).length).toBeLessThanOrEqual(TOOL_SPILL_VIEW_MAX_CHARS);
  });

  it('keeps a third page of 20 widely addressed messages whole in the store, so its index names every message', async () => {
    const crowd = (prefix: string) => Array.from({ length: 50 }, (_, k) => `${prefix}-recipient-${k}@example.test`).join(', ');
    const client = thread(Array.from({ length: 60 }, (_, i) =>
      message(`m${i}`, `message ${i} ${'lorem ipsum dolor '.repeat(200)}`, [{ name: 'To', value: crowd(`to${i}`) }, { name: 'Cc', value: crowd(`cc${i}`) }])));
    const store = inMemoryToolOutputStore();
    const read = async (cursor?: string) => {
      const result = await dispatchTool({ id: 'c1', name: 'read_thread', args: { thread_id: 't', limit: 20, ...(cursor ? { cursor } : {}) } }, ctx, { handlers: [handler(client, 'read_thread')], offload: store });
      return (result as { data: { truncated: boolean; head?: string; inline?: { messages: { id: string }[]; cursor: string | null } } }).data;
    };
    const first = await read();
    const second = await read(first.inline!.cursor!);
    const third = await read(second.inline!.cursor!);
    for (const page of [first, second, third]) {
      expect(page.truncated).toBe(false);
      expect(page.head).toBeUndefined();
    }
    expect(third.inline!.messages.map((m) => m.id)).toEqual(Array.from({ length: 20 }, (_, i) => `m${40 + i}`));
  });

  it('flags a preview-only body and a capped recipient list', () => {
    const view = spillOf([
      { id: 'm0', from: 'a@example.test', at, subject: 'Notes', body: 'preview', body_source: 'snippet', recipients_capped: true },
      { id: 'm1', from: 'a@example.test', at, subject: 'Notes', body: 'whole', body_source: 'plain' },
    ]);
    expect(view.messages[0]).toMatchObject({ body_source: 'snippet', recipients_capped: true });
    expect(view.messages[1]).not.toHaveProperty('body_source');
  });
});

describe('a reply whose parent cannot be found', () => {
  it('a parent id past the first 200 messages is not found, and the fix does not ask for the id already given', async () => {
    const long = thread(Array.from({ length: 205 }, (_, i) => message(`p${i}`, 'note')));
    const result = await dispatch(long, 'send_email', { to: ['sam@example.test'], subject: 'Notes', body_markdown: 'Thanks,', reply_to_thread_id: 't', in_reply_to_msg_id: 'far' });
    expect(result).toMatchObject({ ok: false, code: 'not_found', retryable: false });
    expect(result.ok ? '' : result.fix).not.toContain('Pass in_reply_to_msg_id');
  });
});
