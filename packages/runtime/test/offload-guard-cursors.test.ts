import { describe, expect, it } from 'vitest';
import { buildSessionState } from '@waldo/contracts';
import { googleClient } from '../src/connectors/google';
import { googleHandlers, scribedBody } from '../src/tools/live/google';
import { dispatchTool, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { DEEP_ENCODING_MARKER, guardForOffload, sanitise } from '../src/scribe/sanitiser';
import { inMemoryToolOutputStore } from '../src/conversation/tool-output-store';
import { dispatchLoopTool } from '../src/conversation/tool-loop';

// A full Google page always carries a continuation, so it is also the page large enough to be offloaded. The offload guard
// must store it; the scribe's decode-depth refusal stays for content that really hides a secret, canary or health value.

const canaryTokens = ['1111111111111111', '2222222222222222', '3333333333333333'] as const;
const ctx: ToolDispatcherContext = {
  authenticatedUserId: 'user-1',
  trigger: 'user_message',
  session: buildSessionState({ trigger: 'user_message', canary_tokens: [...canaryTokens], started_at: 1_700_000_000_000 }),
  hasApproval: () => true,
  sourceTaint: null,
  toolArgSourceTaint: null,
  sanitise,
};
const app = { clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'https://example.test/callback' };
const account = { connection_id: 'personal-connection', email: 'owner@example.test' };
const clock = { timezone: 'UTC', now: () => new Date('2026-10-10T00:00:00Z') };
const desk = { propose: async () => '', proposeSendEmail: async () => '', record: () => {} } as never;
const b64 = (text: string) => btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

// Synthetic Google-shaped identifiers: list ids are base64 around a numeric id, and a page token that is printable
// base64 around such an id is two decode layers on its own.
const listIds = [b64('07158634974204820519:0:0'), b64('07158634974204820519:1:0')];
const providerToken = (id: string, page: number) => b64(`${id}:page:${page}`);
const task = (list: number, i: number) => ({
  id: b64(`task${list}x${String(i).padStart(4, '0')}`),
  title: `Pick up “parcel” ${i} ✓ — café`,
  status: 'needsAction',
  due: '2026-10-12T00:00:00.000Z',
  updated: '2026-10-09T10:00:00.000Z',
  position: String(i).padStart(20, '0'),
  webViewLink: `https://tasks.google.com/task/${b64(`task${list}x${i}`)}?sa=6`,
  notes: `- [ ] check https://example.com/a%20b?x=${i}\n- [x] booked\n  - nested step\n"quoted" line\n`.repeat(2),
});

const tasksFetcher = (notes?: string): typeof fetch => (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture' });
  if (url.pathname.endsWith('/users/@me/lists')) {
    const second = url.searchParams.has('pageToken');
    return Response.json({ kind: 'tasks#taskLists', items: [{ id: listIds[second ? 1 : 0], title: second ? 'Work' : 'My Tasks' }], ...(second ? {} : { nextPageToken: providerToken(listIds[0]!, 1) }) });
  }
  const list = url.pathname.includes(listIds[1]!) ? 1 : 0;
  const items = Array.from({ length: 100 }, (_, i) => ({ ...task(list, i), ...(notes && i === 50 ? { notes } : {}) }));
  return Response.json({ kind: 'tasks#tasks', items, nextPageToken: providerToken(listIds[list]!, url.searchParams.has('pageToken') ? 3 : 2) });
}) as typeof fetch;

const getTasks = (fetcher: typeof fetch) => {
  const client = googleClient(app, { refresh_token: 'grant', email: account.email }, fetcher, undefined, account);
  return googleHandlers({ client: async () => client }, desk, clock).find((handler) => handler.name === 'get_tasks')!;
};

const dispatch = (handler: ReturnType<typeof getTasks>, args: Record<string, unknown>, store = inMemoryToolOutputStore()) =>
  dispatchTool({ id: 'gt1', name: handler.name, args }, ctx, { handlers: [handler], offload: store }).then((result) => ({ result, store }));

const storedJson = (store: ReturnType<typeof inMemoryToolOutputStore>, id: string) => {
  const read = store.read(id, 0, 1_000_000)!;
  expect(read.truncated).toBe(false);
  return JSON.parse(read.text) as { next_page_token: string | null; tasks: unknown[] };
};

describe('offloaded Google pages with continuations', () => {
  it('a full get_tasks page across lists is stored, and its stored continuation reads the next page', async () => {
    const handler = getTasks(tasksFetcher());
    const { result, store } = await dispatch(handler, { limit: 100 });
    expect(result).toMatchObject({ ok: true, data: { read_with: 'read_tool_output' } });
    if (!result.ok) return;
    const page = storedJson(store, (result.data as { stored_output: string }).stored_output);
    expect(page.tasks).toHaveLength(100);
    expect(page.next_page_token).toMatch(/^[a-z2-7]+\.[0-9a-f]{64}$/);

    const next = await dispatch(handler, { limit: 100, page_token: page.next_page_token });
    expect(next.result.ok).toBe(true);
  });

  it('a full page in the task id shape Google returns today is stored whole', async () => {
    // Observed in responses, not documented: a newer task id is base64url around 16 random base64url characters, so a
    // page holds a hundred two-layer tokens that must not spend the scribe's depth.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let seed = 7;
    const random16 = () => Array.from({ length: 16 }, () => alphabet[(seed = (seed * 1103515245 + 12345) % 2147483648) % 64]).join('');
    const ids = Array.from({ length: 100 }, () => b64(random16()));
    const fetcher = (async (input: RequestInfo | URL) => {
      const response = await tasksFetcher()(input);
      if (!new URL(String(input)).pathname.endsWith('/tasks')) return response;
      const page = await response.json() as { items: Array<Record<string, unknown>> };
      return Response.json({ ...page, items: page.items.map((item, i) => ({ ...item, id: ids[i], webViewLink: `https://tasks.google.com/task/${ids[i]}?sa=6` })) });
    }) as typeof fetch;
    const { result } = await dispatch(getTasks(fetcher), { limit: 100 });
    expect(result).toMatchObject({ ok: true, data: { read_with: 'read_tool_output' } });
    expect((result as { data: object }).data).not.toHaveProperty('withheld');
  });

  it('a full page of one selected list is stored', async () => {
    const { result } = await dispatch(getTasks(tasksFetcher()), { limit: 100, task_list_id: listIds[1] });
    expect(result).toMatchObject({ ok: true, data: { read_with: 'read_tool_output' } });
  });

  it('a full query_calendar page whose provider token nests base64 twice is stored', async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture' });
      const items = Array.from({ length: 50 }, (_, i) => ({
        id: `evt${i}`, status: 'confirmed', summary: `Planning sync ${i} — “roadmap” ✓`,
        description: `Agenda: https://example.com/specs/v${i}?ref=a%20b\n`.repeat(20),
        start: { dateTime: '2026-10-10T10:00:00Z' }, end: { dateTime: '2026-10-10T11:00:00Z' },
      }));
      return Response.json({ kind: 'calendar#events', items, nextPageToken: providerToken(b64('primary-calendar-0001'), url.searchParams.has('pageToken') ? 3 : 2) });
    }) as typeof fetch;
    const client = googleClient(app, { refresh_token: 'grant', email: account.email }, fetcher, undefined, account);
    const handler = googleHandlers({ client: async () => client }, desk, clock).find((h) => h.name === 'query_calendar')!;
    const store = inMemoryToolOutputStore();
    const args = { limit: 50, date_range: { from: '2026-10-10T00:00:00Z', to: '2026-10-11T00:00:00Z' } };
    const result = await dispatchTool({ id: 'qc1', name: 'query_calendar', args }, ctx, { handlers: [handler], offload: store });
    expect(result).toMatchObject({ ok: true, data: { read_with: 'read_tool_output' } });
    if (!result.ok) return;
    const page = JSON.parse(store.read((result.data as { stored_output: string }).stored_output, 0, 1_000_000)!.text) as { next_page_token: string };
    const next = await dispatchTool({ id: 'qc2', name: 'query_calendar', args: { ...args, page_token: page.next_page_token } }, ctx, { handlers: [handler], offload: store });
    expect(next.ok).toBe(true);
  });

  it('a full search_communication page with a provider continuation is stored', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: `19c8a1b2f3d4e5${i.toString(16).padStart(2, '0')}`, thread_id: `19c8a1b2f3d4e6${i.toString(16).padStart(2, '0')}`,
      from: `Sender ${i} <sender${i}@example.com>`, subject: `Invoice ${1000 + i}`,
      snippet: `Please review https://billing.example.com/i/${1000 + i}?a=%20b — “thanks” ✓ `.repeat(40), at: '2026-10-09T08:15:00Z',
    }));
    const google = { client: async () => ({ account, mailPage: async () => ({ messages, next_page_token: '09876543210123456789', result_size_estimate: 200 }) }) };
    const handler = googleHandlers(google as never, desk, clock).find((h) => h.name === 'search_communication')!;
    const result = await dispatchTool({ id: 'sc1', name: 'search_communication', args: { query: 'invoice', limit: 20 } }, ctx, { handlers: [handler], offload: inMemoryToolOutputStore() });
    expect(result).toMatchObject({ ok: true, data: { read_with: 'read_tool_output' } });
  });

  it('a continuation in the earlier base64 body form is refused before provider I/O', async () => {
    let reads = 0;
    const counting = (async (input: RequestInfo | URL) => { if (!String(input).includes('oauth2')) reads += 1; return tasksFetcher()(input); }) as typeof fetch;
    // Signed exactly as the continuation codec signs, so only the body encoding differs from a current cursor.
    const body = b64(JSON.stringify({ v: 1, list_id: listIds[0], list_token: null, task_token: null, lists_exhausted: false }));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('grant'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const binding = JSON.stringify(['all-list Tasks', account, 'todo', 100]);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${binding}.${body}`)));
    const legacy = `${body}.${[...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const result = await getTasks(counting).handle({ status: 'todo', limit: 100, page_token: legacy } as never) as { ok: boolean; error?: string };
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('invalid all-list Tasks cursor') });
    expect(reads).toBe(0);
  });
});

describe('a value encoded past the decode limit is withheld, not the whole page', () => {
  const thrice = (text: string) => b64(b64(b64(text)));
  const layers = (text: string) => [b64(b64(b64(text))), b64(b64(text)), b64(text)];
  const recording = () => {
    const inner = inMemoryToolOutputStore();
    const kept: string[] = [];
    return { kept, store: { ...inner, put: (output: string, provenance?: { call_id?: string }) => { kept.push(output); return inner.put(output, provenance); } } };
  };

  it('a full page whose one task note is ordinary words encoded three times is stored, that note withheld in place', async () => {
    // Before: tool result failed the offload guard: size_cap:invalid_payload:decode:nesting:base64:3
    const words = 'ordinary words, encoded three times';
    const { kept, store } = recording();
    const { result } = await dispatch(getTasks(tasksFetcher(`call the plumber ${thrice(words)} before noon`)), { limit: 100 }, store);
    expect(result).toMatchObject({ ok: true, data: { read_with: 'read_tool_output', withheld: { count: 1 } } });
    const page = JSON.parse(kept[0]!) as { tasks: Array<{ notes: string }> };
    expect(page.tasks).toHaveLength(100);
    expect(page.tasks[50]!.notes).toBe(`call the plumber ${DEEP_ENCODING_MARKER} before noon`);
    expect(page.tasks[51]!.notes).toBe(task(0, 51).notes);
    for (const layer of [...layers(words), words]) expect(kept[0]).not.toContain(layer);
  });

  it('a canary encoded three times never reaches the store or the model', async () => {
    const { kept, store } = recording();
    const { result } = await dispatch(getTasks(tasksFetcher(thrice(canaryTokens[1]))), { limit: 100 }, store);
    expect(result).toMatchObject({ ok: true, data: { withheld: { count: 1 } } });
    const seen = JSON.stringify(result) + kept.join('');
    for (const layer of [...layers(canaryTokens[1]), canaryTokens[1]]) expect(seen).not.toContain(layer);
  });

  it('a secret encoded three times is withheld, never stored', async () => {
    const secret = `token sk-proj-${'A1b2C3d4'.repeat(4)}`;
    const { kept, store } = recording();
    const { result } = await dispatch(getTasks(tasksFetcher(thrice(secret))), { limit: 100 }, store);
    expect(result).toMatchObject({ ok: true });
    for (const layer of [...layers(secret), 'sk-proj-']) expect(kept.join('')).not.toContain(layer);
  });

  it('a canary the partial decode already shows still refuses the page, though its token nests too deep', async () => {
    const { kept, store } = recording();
    const { result } = await dispatch(getTasks(tasksFetcher(b64(`ref ${canaryTokens[2]} ${b64(b64('ordinary words, encoded'))}`))), { limit: 100 }, store);
    expect(result).toMatchObject({ ok: false, guard: { check: 'canary_token', reason: 'canary_leak' } });
    expect(kept).toHaveLength(0);
  });

  it('a small result read inline withholds the value in place and keeps the rest', async () => {
    const page = { tasks: [{ title: 'Pay rent', notes: `see ${thrice('ordinary words, encoded three times')}` }, { title: 'Buy milk', notes: 'two litres' }] };
    const scribed = sanitise({ payload: page, destination: 'internal_context', canary_tokens: [...canaryTokens], source_taint: 'external' });
    expect(scribed).toEqual({ ok: true, source_taint: 'external', redactions: [{ kind: 'deep_encoding', count: 1 }], payload: { tasks: [{ title: 'Pay rent', notes: `see ${DEEP_ENCODING_MARKER}` }, page.tasks[1]] } });
  });

  it('a canary encoded three times never reaches the model on the inline path', () => {
    const scribed = sanitise({ payload: { notes: thrice(canaryTokens[1]) }, destination: 'internal_context', canary_tokens: [...canaryTokens], source_taint: 'external' });
    expect(scribed).toMatchObject({ ok: true, payload: { notes: DEEP_ENCODING_MARKER } });
  });

  it('a mail body with a deeply encoded tracking link keeps the rest of its text', () => {
    const link = `https://click.example.com/ls/click?upn=${thrice('https://shop.example.com/sale?ref=newsletter')}`;
    const body = `Hi Sam,\n\nYour order shipped. Track it here: ${link}\n\nThanks`;
    expect(scribedBody(body, canaryTokens)).toBe(body.replace(link.slice(link.indexOf('?') + 1), DEEP_ENCODING_MARKER));
  });

  it('a deep token whose head alone is percent-encoded is withheld whole, not just the wrapped head', () => {
    const deep = thrice('ordinary words, encoded three times');
    const percent = (text: string) => [...text].map((character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`).join('');
    const scribed = sanitise({ payload: { notes: `see ${percent(deep.slice(0, 6))}${deep.slice(6)} y` }, destination: 'internal_context', canary_tokens: [...canaryTokens], source_taint: 'external' });
    expect(scribed).toEqual({ ok: true, source_taint: 'external', redactions: [{ kind: 'deep_encoding', count: 1 }], payload: { notes: `see ${DEEP_ENCODING_MARKER} y` } });
  });

  it('a secret the partial decode already shows still refuses the page, though its token nests too deep', async () => {
    const { kept, store } = recording();
    const { result } = await dispatch(getTasks(tasksFetcher(b64(`key sk-proj-${'A1b2C3d4'.repeat(4)} ${b64(b64('ordinary words, encoded'))}`))), { limit: 100 }, store);
    expect(result).toMatchObject({ ok: false, guard: { check: 'canary_token', reason: 'secret_leak' } });
    expect(kept).toHaveLength(0);
  });

  // The first scans stop at the first value they cannot decode, so whatever else the page holds is found only when the
  // scans run again over the page with its deep values withheld.
  describe('the scans run again after withholding, so the rest of the page is still checked', () => {
    const deep = thrice('ordinary words, encoded three times');
    const inline = (payload: Record<string, unknown>) => sanitise({ payload: payload as never, destination: 'internal_context', canary_tokens: [...canaryTokens], source_taint: 'external' });
    const offload = (payload: Record<string, unknown>) => guardForOffload({ payload: JSON.stringify(payload), destination: 'internal_context', canary_tokens: [...canaryTokens], source_taint: 'external' });

    it('a plain canary in another task refuses the page, inline and offloaded', () => {
      const page = { tasks: [{ notes: deep }, { notes: `ref ${canaryTokens[1]}` }] };
      for (const scribed of [inline(page), offload(page)]) expect(scribed).toMatchObject({ ok: false, check: 'canary_token', reason: 'canary_leak' });
    });

    it('a plain canary glued to a deep token refuses the page rather than going with the widened span', () => {
      const page = { tasks: [{ notes: `ref ${canaryTokens[1]}${deep} y` }] };
      for (const scribed of [inline(page), offload(page)]) expect(scribed).toMatchObject({ ok: false, check: 'canary_token', reason: 'canary_leak' });
    });

    it('a deep key beside a deep value refuses the page as a decode, inline and offloaded', () => {
      const page = { tasks: [{ notes: deep }, { [thrice('another key, encoded three times')]: 'x' }] };
      for (const scribed of [inline(page), offload(page)]) {
        expect(scribed).toMatchObject({ ok: false, reason: 'invalid_payload', diagnostic: { stage: 'decode', decode: { cause: 'nesting', depth: 3 } } });
      }
    });

    it('a visible reading in another task refuses the offloaded page', () => {
      expect(offload({ tasks: [{ notes: deep }, { notes: 'hrv: 42 ms overnight' }] })).toMatchObject({ ok: false, check: 'health_value', reason: 'health_value_leak' });
    });
  });

  it('a value that nests only beside its neighbour is withheld whole', () => {
    // One character of a twice-encoded token is percent-encoded: no token alone nests, the decoded whole does.
    const joined = b64(b64('ordinary words, encoded'));
    const notes = `${joined.slice(0, 8)}%${joined.charCodeAt(8).toString(16).toUpperCase()}${joined.slice(9)}`;
    const scribed = sanitise({ payload: { notes }, destination: 'internal_context', canary_tokens: [...canaryTokens], source_taint: 'external' });
    expect(scribed).toMatchObject({ ok: true, payload: { notes: DEEP_ENCODING_MARKER }, redactions: [{ kind: 'deep_encoding', count: 1 }] });
  });

  it('every other destination still refuses the same value', () => {
    const notes = thrice('ordinary words, encoded three times');
    for (const destination of ['send_message', 'draft_email', 'memory_block', 'owner_reply'] as const) {
      expect(sanitise({ payload: { notes }, destination, canary_tokens: [...canaryTokens], source_taint: 'external' }))
        .toMatchObject({ ok: false, check: 'size_cap', reason: 'invalid_payload', diagnostic: { stage: 'decode', decode: { cause: 'nesting', depth: 3 } } });
    }
    expect(sanitise({ payload: { notes }, destination: 'internal_context', canary_tokens: [...canaryTokens], source_taint: null }))
      .toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it('the marker itself decodes to nothing and passes every check', () => {
    expect(sanitise({ payload: DEEP_ENCODING_MARKER, destination: 'memory_block', canary_tokens: [...canaryTokens], source_taint: 'external' }))
      .toEqual({ ok: true, payload: DEEP_ENCODING_MARKER, source_taint: 'external', redactions: [] });
  });
});

describe('the offload guard still refuses hidden content in a stored page', () => {
  // An object key is never withheld: rewriting it would change the result's shape.
  const nestedKey = { ...getTasks(tasksFetcher()), handle: async () => ({ ok: true, data: { tasks: [{ [b64(b64(b64('ordinary words, encoded three times')))]: 'x'.repeat(40_000) }] }, source_taint: 'external' }) } as never;

  it('a key encoded three times is refused, and the trace names the stage', async () => {
    let puts = 0;
    const inner = inMemoryToolOutputStore();
    const store = { ...inner, put: (output: string, provenance?: { call_id?: string }) => { puts += 1; return inner.put(output, provenance); } };
    const result = await dispatchTool({ id: 'gt1', name: 'get_tasks', args: { limit: 100 } }, ctx, { handlers: [nestedKey], offload: store });
    expect(result).toMatchObject({
      ok: false, code: 'forbidden', reason: 'sanitise_denied',
      error: 'tool result failed the offload guard: size_cap:invalid_payload:decode:nesting:base64:3',
      guard: { check: 'size_cap', reason: 'invalid_payload', diagnostic: { stage: 'decode', decode: { cause: 'nesting', kind: 'base64', depth: 3 } } },
    });
    expect(puts).toBe(0);
  });

  it('the loop result hands the trace hop the denial stage as one enum label', async () => {
    const result = await dispatchLoopTool(
      { call_id: 'gt2', name: 'get_tasks', arguments: JSON.stringify({ limit: 100 }) } as never,
      { handlers: [nestedKey], ctx, offload: inMemoryToolOutputStore() },
    );
    expect(result).toMatchObject({ ok: false, guard: 'size_cap:invalid_payload:decode:nesting:base64:3' });
  });

  it('a plainly written secret and a canary in a task note are still refused', async () => {
    for (const [notes, reason] of [[`key sk-proj-${'A1b2C3d4'.repeat(4)}`, 'secret_leak'], [`ref ${canaryTokens[1]}`, 'canary_leak']] as const) {
      const { result } = await dispatch(getTasks(tasksFetcher(notes)), { limit: 100 });
      expect(result).toMatchObject({ ok: false, guard: { check: 'canary_token', reason } });
    }
  });

  it('a raw sensor reading in a stored page is still refused', () => {
    const page = JSON.stringify({ tasks: [{ title: 'note', notes: 'hrv: 42 ms overnight' }], next_page_token: null });
    expect(guardForOffload({ payload: page, destination: 'internal_context', canary_tokens: [...canaryTokens], source_taint: 'external' }))
      .toMatchObject({ ok: false, check: 'health_value', reason: 'health_value_leak' });
  });
});
