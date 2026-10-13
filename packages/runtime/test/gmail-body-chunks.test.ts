import { describe, expect, it } from 'vitest';
import { buildSessionState, readThreadArgsSchema } from '@waldo/contracts';
import { b64url, googleClient } from '../src/connectors/google';
import { inMemoryToolOutputStore } from '../src/conversation/tool-output-store';
import { sanitise } from '../src/scribe/sanitiser';
import { dispatchTool, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { googleHandlers, type ArtifactRelay } from '../src/tools/live/google';

// Synthetic mail only. The chunk and attachment cases follow draft #1042's mail tests; here every read
// prepares the whole body before any chunk is cut.
const app = { clientId: 'c', clientSecret: 's', redirectUri: 'https://example.invalid' };
// Encoded 8,190 bytes (a multiple of 3, so no padding mid-string) at a time: spreading a 200,000-byte body
// into one call overflows the stack.
const encode = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return Array.from({ length: Math.ceil(bytes.length / 8_190) }, (_, i) => b64url(bytes.subarray(i * 8_190, (i + 1) * 8_190))).join('');
};
const words = (length: number) => 'lorem ipsum '.repeat(Math.ceil(length / 12)).slice(0, length);
const long = words(70_000);
const thread = (messages: unknown[]) => googleClient(app, { refresh_token: 'r' }, (async (input: RequestInfo | URL) =>
  String(input).includes('oauth2') ? Response.json({ access_token: 'a' }) : Response.json({ messages })) as typeof fetch);
const plain = (id: string, body: string, subject = 'Notes') => ({ id, internalDate: '1791417600000', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'sender@example.test' }, { name: 'Subject', value: subject }], body: { data: encode(body) } } });
const desk = { propose: async () => '', proposeSendEmail: async () => '', record: () => {} };
const reader = (client: ReturnType<typeof thread>, relay: ArtifactRelay = async () => true) =>
  googleHandlers({ client: async () => client }, desk, { timezone: 'UTC', now: () => new Date() }, relay).find(h => h.name === 'read_thread')!;
type Shown = { id: string; body: string; body_total_chars?: number; body_next_offset?: number; body_truncated?: true; attachments?: unknown; quarantined?: readonly string[] };
const shown = (result: unknown) => (result as { data: { messages: Shown[] } }).data.messages;
// Reads one message's whole body the way the model would: the first read, then each continuation.
const readAll = async (read: ReturnType<typeof reader>, first: Shown) => {
  const chunks = [first.body];
  for (let offset = first.body_next_offset; offset !== undefined;) {
    const [next] = shown(await read.handle({ thread_id: 't', limit: 10, body_message_id: first.id, body_offset: offset } as never));
    chunks.push(next!.body);
    offset = next!.body_next_offset;
  }
  return chunks;
};

describe('the connector under the full-bodies opt-in', () => {
  it('returns the whole body, and only the asked-for message on a continuation', async () => {
    const client = thread([plain('m1', long), plain('m2', 'short')]);
    expect((await client.threadPage!('t', 10)).messages[0]!.body).toHaveLength(32_000);
    const full = await client.threadPage!('t', 10, undefined, { fullBodies: true, bodyChunks: true });
    expect(full.messages.map(m => m.body.length)).toEqual([70_000, 5]);
    const one = await client.threadPage!('t', 10, undefined, { fullBodies: true, messageId: 'm2' });
    expect(one).toEqual({ messages: [expect.objectContaining({ id: 'm2', body: 'short' })], cursor: null });
    await expect(client.threadPage!('t', 10, undefined, { fullBodies: true, messageId: 'nope' })).rejects.toThrow('unknown message in thread');
  });

  it('lists attachment names, types and sizes, never ids or content, and only under the opt-in', async () => {
    const client = thread([{ id: 'm1', internalDate: '1791417600000', payload: { mimeType: 'multipart/mixed', headers: [], parts: [
      { mimeType: 'text/plain', body: { data: encode('see attached') } },
      { mimeType: 'application/pdf', filename: 'plan.pdf', body: { attachmentId: 'att-secret-1', size: 12_345 } },
      { mimeType: 'image/png', filename: 'chart.png', body: { attachmentId: 'att-secret-2', size: 99 } },
    ] } }]);
    expect((await client.threadPage!('t', 10)).messages[0]).not.toHaveProperty('attachments');
    const [message] = (await client.threadPage!('t', 10, undefined, { fullBodies: true, bodyChunks: true })).messages;
    expect(message!.attachments).toEqual([{ filename: 'plan.pdf', mime_type: 'application/pdf', size: 12_345 }, { filename: 'chart.png', mime_type: 'image/png', size: 99 }]);
    expect(JSON.stringify(message)).not.toContain('att-secret');
  });
});

describe('a reader that predates chunks', () => {
  it('keeps the 32,000-character body and gets no attachment names, so the proxy can deploy before the Worker', async () => {
    const client = thread([{ id: 'm1', internalDate: '1791417600000', payload: { mimeType: 'multipart/mixed', headers: [], parts: [
      { mimeType: 'text/plain', body: { data: encode(long) } },
      { mimeType: 'application/pdf', filename: 'Your login code is 482913.pdf', body: { attachmentId: 'a1', size: 10 } },
    ] } }]);
    const [message] = (await client.threadPage!('t', 10, undefined, { fullBodies: true })).messages;
    expect(message!.body).toHaveLength(32_000);
    expect(message).not.toHaveProperty('body_full_chars');
    expect(message).not.toHaveProperty('attachments');
  });
});

describe('read_thread body chunks', () => {
  it('returns the first chunk with the total and the next offset, and later chunks meet without gap or overlap', async () => {
    const read = reader(thread([plain('m1', long), plain('m2', 'short')]));
    const [m1, m2] = shown(await read.handle({ thread_id: 't', limit: 10 } as never));
    expect(m1).toMatchObject({ body: long.slice(0, 12_000), body_total_chars: 70_000, body_next_offset: 12_000 });
    expect(m2!.body).toBe('short');
    expect(m2).not.toHaveProperty('body_next_offset');
    const chunks = await readAll(read, m1!);
    expect(chunks.map(chunk => chunk.length)).toEqual([12_000, 12_000, 12_000, 12_000, 12_000, 10_000]);
    expect(chunks.join('')).toBe(long);
  });

  it('shares one budget across a read, so every message is listed and the rest is read by offset', async () => {
    const bodies = ['a', 'b', 'c', 'd', 'e'].map(id => `${id} ${words(19_997)}`);
    const read = reader(thread(bodies.map((body, i) => plain(`m${i + 1}`, body))));
    const messages = shown(await read.handle({ thread_id: 't', limit: 10 } as never));
    expect(messages.map(m => [m.id, m.body.length, m.body_next_offset])).toEqual([['m1', 12_000, 12_000], ['m2', 12_000, 12_000], ['m3', 12_000, 12_000], ['m4', 4_000, 4_000], ['m5', 0, 0]]);
    expect((await readAll(read, messages[4]!)).join('')).toBe(bodies[4]);
  });

  it('refuses an offset past the end of the body', async () => {
    const result = await reader(thread([plain('m1', long)])).handle({ thread_id: 't', limit: 10, body_message_id: 'm1', body_offset: 80_000 } as never);
    expect(result.ok).toBe(false);
  });

  // A connector-proxy older than this change ignores the message id (and, before #1105, the full-bodies opt-in
  // too), returning the thread's first page. Its bodies stop at 32,000, so a continuation is still needed past 12,000.
  const older = (client: ReturnType<typeof thread>, fullBodies: boolean) => ({ ...client, threadPage: (id: string, limit: number, cursor?: string | null) =>
    client.threadPage!(id, limit, cursor ?? undefined, fullBodies ? { fullBodies: true } : undefined) }) as typeof client;
  const marked = (count: number) => Array.from({ length: count }, (_, i) => plain(`m${i}`, `${words(12_500)} marker-${i}. ${words(10_000)}`));

  it('finds the asked-for message by paging when the proxy ignores the message id', async () => {
    for (const fullBodies of [true, false]) {
      const [next] = shown(await reader(older(thread(marked(25)), fullBodies)).handle({ thread_id: 't', limit: 10, body_message_id: 'm22', body_offset: 12_000 } as never));
      expect(next!.id).toBe('m22');
      expect(next!.body).toContain('marker-22.');
      expect(next!.body).not.toContain('marker-0.');
    }
  });

  it('fails a continuation rather than return another message when paging cannot find it', async () => {
    expect((await reader(older(thread(marked(3)), true)).handle({ thread_id: 't', limit: 10, body_message_id: 'nope', body_offset: 0 } as never)).ok).toBe(false);
    // Paging stops after 10 pages of 20, as the reply-parent lookup does.
    const far = [...Array.from({ length: 205 }, (_, i) => plain(`s${i}`, 'short')), plain('m0', long)];
    expect((await reader(older(thread(far), true)).handle({ thread_id: 't', limit: 10, body_message_id: 'm0', body_offset: 0 } as never)).ok).toBe(false);
  });

  it('never shows part of a code or reset link that straddles a chunk boundary, and relays each once', async () => {
    const reset = 'https://auth.example.com/verify?token=synthetic-reset-9f2c&type=recovery';
    const relays: unknown[] = [];
    const read = reader(thread([
      plain('m1', `${words(11_985)} Your login code is 654321. ${words(20_000)}`),
      plain('m2', `${words(11_960)} ${reset} end ${words(20_000)}`),
    ]), async (_from, artifacts) => { relays.push(artifacts); return true; });
    const first = shown(await read.handle({ thread_id: 't', limit: 10 } as never));
    const all = JSON.stringify([...await readAll(read, first[0]!), ...await readAll(read, first[1]!)]);
    for (const leaked of ['654321', 'de is 65', 'synthetic-reset', 'token=']) expect(all).not.toContain(leaked);
    expect(relays).toEqual([[{ kind: 'otp', value: '654321' }], [{ kind: 'password_reset', value: reset }]]);
  });

  it('withholds a health reading split across a chunk boundary, which the per-result scribe would pass', async () => {
    const read = reader(thread([plain('m1', `${words(11_987)} Asha slept 5 hours last night. ${words(5_000)}`)]));
    const chunks = await readAll(read, shown(await read.handle({ thread_id: 't', limit: 10 } as never))[0]!);
    // Each chunk as the model receives it: one tool result through the scribe.
    const scribed = chunks.map(body => {
      const result = sanitise({ payload: { body }, destination: 'internal_context', source_taint: 'external', canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'] });
      return result.ok ? (result.payload as { body: string }).body : '';
    }).join('');
    expect(scribed).toContain('Asha [health value withheld] last night.');
    expect(scribed).not.toContain('slept 5');
  });

  it('never shows the first part of a code or link cut by the connector bound, and says the body was cut', async () => {
    // Each artifact straddles the connector's 200,000-character bound, so neither is complete in what it returns.
    const reset = 'https://auth.example.com/verify?token=synthetic-reset-9f2c&type=recovery';
    const link = `${words(200_000 - reset.indexOf('&type'))}${reset} tail ${words(500)}`;
    const code = `${words(200_000 - 'Use 654321 is your'.length)}Use 654321 is your sign-in code. ${words(500)}`;
    const read = reader(thread([plain('m1', link), plain('m2', code)]));
    const first = shown(await read.handle({ thread_id: 't', limit: 10 } as never));
    for (const message of first) expect(message).toMatchObject({ body_truncated: true });
    const text = [...await readAll(read, first[0]!), ...await readAll(read, first[1]!)].join('');
    for (const leaked of ['synthetic-reset', 'token=', '654321']) expect(text).not.toContain(leaked);
    expect(text.length).toBeGreaterThan(390_000);
  });

  it('omits an unbroken run longer than 2,048 characters from the body and the link scan, and still relays a real link', async () => {
    const hostile = 'https://a'.repeat(2_300);
    const relays: unknown[] = [];
    const client = thread([{ id: 'm1', internalDate: '1791417600000', payload: { mimeType: 'text/html', headers: [], body: { data: encode(`<p>Before ${hostile} after.</p><a href="https://auth.example.com/auth/v1/verify?token=synthetic-token-7f3a">Sign in</a>`) } } }]);
    // A connector-proxy without the link-length cap still passes a hostile link target to the scan. An over-long
    // target is never relayed, even when it ends like a sign-in link.
    const uncapped = { ...client, threadPage: async (...args: Parameters<NonNullable<typeof client.threadPage>>) => {
      const page = await client.threadPage!(...args);
      return { ...page, messages: page.messages.map(message => ({ ...message, artifact_scan: `${hostile}/auth/v1/verify?token=x\n${message.artifact_scan}` })) };
    } } as typeof client;
    const [message] = shown(await reader(uncapped, async (_from, artifacts) => { relays.push(artifacts); return true; }).handle({ thread_id: 't', limit: 10 } as never));
    expect(message!.body).toContain(`Before [${hostile.length} characters of unbroken text omitted] after.`);
    expect(message!.body).not.toContain('https://ahttps://a');
    expect(relays).toEqual([[{ kind: 'magic_link', value: 'https://auth.example.com/auth/v1/verify?token=synthetic-token-7f3a' }]]);
  });

  it('keeps the source-app marker when the relay reports that its send failed', async () => {
    const read = reader(thread([plain('m1', 'Your login code is 654321.')]), async () => false);
    const [message] = shown(await read.handle({ thread_id: 't', limit: 10 } as never));
    expect(message!.body).toContain('[quarantined: otp artifact - view in the source app]');
    expect(message!.body).not.toContain('sent to the owner');
  });

  it('quarantines a verification code in an attachment name, and lists attachments only on the first read', async () => {
    const client = thread([{ id: 'm1', internalDate: '1791417600000', payload: { mimeType: 'multipart/mixed', headers: [], parts: [
      { mimeType: 'text/plain', body: { data: encode(long) } },
      { mimeType: 'application/pdf', filename: 'Your login code is 482913.pdf', body: { attachmentId: 'a1', size: 10 } },
    ] } }]);
    const read = reader(client);
    const [message] = shown(await read.handle({ thread_id: 't', limit: 10 } as never));
    expect(JSON.stringify(message)).not.toContain('482913');
    expect(message!.quarantined).toEqual(['otp']);
    const [next] = shown(await read.handle({ thread_id: 't', limit: 10, body_message_id: 'm1', body_offset: 12_000 } as never));
    expect(next).not.toHaveProperty('attachments');
  });
});

describe('read_thread through the dispatcher', () => {
  const ctx = {
    authenticatedUserId: 'user-1', trigger: 'user_message', hasApproval: () => true, sourceTaint: null, toolArgSourceTaint: null, sanitise,
    session: buildSessionState({ trigger: 'user_message', canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1_700_000_000_000 }),
  } as ToolDispatcherContext;

  it('returns a continuation inline, and stores a long first read whole with each next offset ahead of its body', async () => {
    const read = reader(thread(['a', 'b', 'c', 'd', 'e', 'f'].map(id => plain(`m${id}`, `${id} ${words(69_998)}`))));
    const store = inMemoryToolOutputStore();
    const first = await dispatchTool({ id: 'c1', name: 'read_thread', args: { thread_id: 't' } }, ctx, { handlers: [read], offload: store });
    expect(first).toMatchObject({ ok: true });
    const receipt = (first as { data: { stored_output: string; truncated: boolean; head: string } }).data;
    expect(receipt.truncated).toBe(false);
    expect(receipt.head).toMatch(/"body_next_offset":12000.*"body":/s);
    const stored = JSON.parse(store.read(receipt.stored_output, 0, 65_536)!.text) as { messages: Shown[] };
    expect(stored.messages.map(m => m.body_next_offset)).toEqual([12_000, 12_000, 12_000, 4_000, 0, 0]);
    const next = await dispatchTool({ id: 'c2', name: 'read_thread', args: { thread_id: 't', body_message_id: 'mf', body_offset: 0 } }, ctx, { handlers: [read], offload: store });
    expect(next.ok && shown(next)[0]).toMatchObject({ id: 'mf', body: `f ${words(69_998)}`.slice(0, 12_000), body_next_offset: 12_000 });
  });
});

describe('read_thread arguments', () => {
  it('take a body continuation as a message id and an offset together, never with a thread cursor', () => {
    expect(readThreadArgsSchema.safeParse({ thread_id: 't', body_message_id: 'm1', body_offset: 32_000 }).success).toBe(true);
    expect(readThreadArgsSchema.safeParse({ thread_id: 't', body_message_id: 'm1' }).success).toBe(false);
    expect(readThreadArgsSchema.safeParse({ thread_id: 't', body_offset: 0 }).success).toBe(false);
    expect(readThreadArgsSchema.safeParse({ thread_id: 't', body_message_id: 'm1', body_offset: 0, cursor: 'c' }).success).toBe(false);
    expect(readThreadArgsSchema.safeParse({ thread_id: 't', body_message_id: 'm1', body_offset: -1 }).success).toBe(false);
  });
});
