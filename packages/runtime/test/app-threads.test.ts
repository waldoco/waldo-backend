import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_THREAD_MAX_V1, appThreadListV1Schema, appThreadOperationResultV1Schema, appThreadReadV1Schema } from '../../contracts/src/app/threads';
import { appSubjectFor } from '../src/channels/app-api';

const OWNER_ID = '5b1f0c2a-7d3e-4c91-8f62-0a1b2c3d4e5f';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const { OwnerDO } = await import('../src/channels/owner-do');
type Owner = InstanceType<typeof OwnerDO>;

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const withOwner = (name: string, work: (call: (method: string, path: string, body?: unknown) => Promise<Readonly<{ status: number; body: any }>>, state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    const owner: Owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await owner.fetch(new Request(`https://telegram-owner/app/v1/threads${path}`, { method, headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      return { status: response.status, body: await response.json() };
    };
    await work(call, state);
  });
const op = (n: number) => `0b6f3c1e-8a2d-4f5b-9c7e-${String(n).padStart(12, '0')}`;
const recorded = (body: unknown) => appThreadOperationResultV1Schema.parse(body);

describe('the app threads registry', () => {
  it('creates, lists, reads, renames, archives and deletes a thread, every answer in the shape the app pins', async () => {
    await withOwner('threads-lifecycle', async call => {
      const created = recorded((await call('POST', '', { operation_id: op(1), title: '  Trip planning  ' })).body);
      expect(created).toMatchObject({ state: 'recorded', revision: 1, title_revision: 1, thread_state: 'active' });
      const id = created.thread_id;
      const untitled = recorded((await call('POST', '', { operation_id: op(2) })).body);

      const listed = appThreadListV1Schema.parse((await call('GET', '')).body);
      expect(new Set(listed.threads.map(thread => thread.thread_id))).toEqual(new Set([id, untitled.thread_id]));
      expect(listed.threads.find(thread => thread.thread_id === id)).toMatchObject({ title: 'Trip planning', preview: null, state: 'active' });
      expect(listed.threads.find(thread => thread.thread_id === untitled.thread_id)!.title).toBeNull();

      const read = appThreadReadV1Schema.parse((await call('GET', `/${id}?limit=10`)).body);
      expect(read).toMatchObject({ thread: { thread_id: id, revision: 1 }, history: { messages: [], next_cursor: null } });

      expect(recorded((await call('POST', `/${id}/rename`, { operation_id: op(3), expected_title_revision: 1, title: 'Lisbon trip' })).body))
        .toMatchObject({ revision: 1, title_revision: 2, thread_state: 'active' });
      expect(recorded((await call('POST', `/${id}/archive`, { operation_id: op(4), expected_revision: 1, archived: true })).body))
        .toMatchObject({ revision: 2, title_revision: 2, thread_state: 'archived' });
      expect(appThreadListV1Schema.parse((await call('GET', '?state=active')).body).threads.map(thread => thread.thread_id)).toEqual([untitled.thread_id]);
      expect(appThreadListV1Schema.parse((await call('GET', '?state=archived')).body).threads.map(thread => [thread.thread_id, thread.title])).toEqual([[id, 'Lisbon trip']]);

      expect(recorded((await call('POST', `/${id}/delete`, { operation_id: op(5), expected_revision: 2 })).body)).toMatchObject({ revision: 3, thread_state: 'deleted' });
      expect(await call('GET', `/${id}`)).toEqual({ status: 410, body: { error: 'thread_deleted' } });
      expect(await call('POST', `/${id}/rename`, { operation_id: op(6), expected_title_revision: 2, title: 'Again' })).toEqual({ status: 410, body: { error: 'thread_deleted' } });
      expect(appThreadListV1Schema.parse((await call('GET', '?state=all')).body).threads.map(thread => thread.thread_id)).toEqual([untitled.thread_id]);
    });
  });

  it('an operation repeated with the same request returns its first result; under a different request it is refused', async () => {
    await withOwner('threads-operations', async call => {
      const first = await call('POST', '', { operation_id: op(1), title: 'Taxes' });
      expect(await call('POST', '', { operation_id: op(1), title: 'Taxes' })).toEqual(first);
      expect(appThreadListV1Schema.parse((await call('GET', '')).body).threads).toHaveLength(1);
      expect(await call('POST', '', { operation_id: op(1), title: 'Something else' })).toEqual({ status: 409, body: { error: 'operation_conflict' } });
      expect(await call('GET', `/operations/${op(1)}`)).toEqual(first);
      expect(await call('GET', `/operations/${op(9)}`)).toEqual({ status: 404, body: { error: 'thread_not_found' } });

      const id = first.body.thread_id;
      expect(await call('POST', `/${id}/rename`, { operation_id: op(2), expected_title_revision: 7, title: 'Late' })).toEqual({ status: 409, body: { error: 'title_revision_conflict' } });
      // A refused operation records nothing, so the same id can be sent again once the client has reread.
      expect(recorded((await call('POST', `/${id}/rename`, { operation_id: op(2), expected_title_revision: 1, title: 'Late' })).body).title_revision).toBe(2);
      expect(await call('POST', `/${id}/archive`, { operation_id: op(3), expected_revision: 2, archived: true })).toEqual({ status: 409, body: { error: 'thread_revision_conflict' } });
    });
  });

  it('renaming never moves the revision a running reply is fenced on, and archiving twice moves it once', async () => {
    await withOwner('threads-revisions', async call => {
      const id = recorded((await call('POST', '', { operation_id: op(1) })).body).thread_id;
      expect(recorded((await call('POST', `/${id}/rename`, { operation_id: op(2), expected_title_revision: 1, title: 'Named' })).body).revision).toBe(1);
      expect(recorded((await call('POST', `/${id}/archive`, { operation_id: op(3), expected_revision: 1, archived: true })).body).revision).toBe(2);
      expect(recorded((await call('POST', `/${id}/archive`, { operation_id: op(4), expected_revision: 2, archived: true })).body)).toMatchObject({ revision: 2, thread_state: 'archived' });
      expect(recorded((await call('POST', `/${id}/archive`, { operation_id: op(5), expected_revision: 2, archived: false })).body)).toMatchObject({ revision: 3, thread_state: 'active' });
    });
  });

  it('holds at most the pinned number of live threads; a deleted thread frees its place', async () => {
    await withOwner('threads-capacity', async (call, state) => {
      for (let n = 0; n < APP_THREAD_MAX_V1 - 1; n += 1) {
        const id = `thr_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        state.storage.kv.put(`app:thread:${id}`, { thread_id: id, title: null, revision: 1, title_revision: 1, state: n % 2 ? 'archived' : 'active', created_at: n, last_activity_at: n });
      }
      const last = recorded((await call('POST', '', { operation_id: op(1) })).body).thread_id;
      expect(await call('POST', '', { operation_id: op(2) })).toEqual({ status: 429, body: { error: 'thread_capacity' } });
      expect(appThreadListV1Schema.parse((await call('GET', '')).body).threads).toHaveLength(APP_THREAD_MAX_V1);
      await call('POST', `/${last}/delete`, { operation_id: op(3), expected_revision: 1 });
      expect((await call('POST', '', { operation_id: op(4) })).status).toBe(200);
    });
  });

  it('refuses malformed requests and unknown threads without writing anything', async () => {
    await withOwner('threads-refusals', async (call, state) => {
      expect(await call('POST', '', { operation_id: op(1), title: '   ' })).toEqual({ status: 400, body: { error: 'invalid_request' } });
      expect(await call('POST', '', { operation_id: 'not-a-uuid' })).toEqual({ status: 400, body: { error: 'invalid_request' } });
      expect(await call('GET', '?state=deleted')).toEqual({ status: 400, body: { error: 'invalid_request' } });
      expect(await call('GET', '/thr_not-an-id')).toEqual({ status: 404, body: { error: 'not_found' } });
      const unknown = 'thr_11111111-2222-4333-8444-555555555555';
      expect(await call('GET', `/${unknown}`)).toEqual({ status: 404, body: { error: 'thread_not_found' } });
      expect(await call('POST', `/${unknown}/delete`, { operation_id: op(2), expected_revision: 1 })).toEqual({ status: 404, body: { error: 'thread_not_found' } });
      expect(await call('GET', `/${unknown}?limit=51`)).toEqual({ status: 400, body: { error: 'invalid_request' } });
      expect([...state.storage.kv.list({ prefix: 'app:thread' })]).toEqual([]);
    });
  });
});
