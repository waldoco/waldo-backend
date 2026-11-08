// A background task started in an app thread that stops on the owner's card shows that card in its own thread, for a build that
// reads chat revision 9. Older builds read the thread as before; the card is in the Approvals list for every build.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appThreadOperationResultV1Schema, appThreadReadV1Schema } from '../../contracts/src/app/threads';
import { appSubjectFor } from '../src/channels/app-api';
import { approvalDesk } from '../src/channels/approvals';
import { sha256Hex } from '../src/connectors/google';
import { stableJson } from '../src/context-composer/canonical';
import { jobBook, type TaskBrief } from '../src/tasks/jobs';

const OWNER_ID = '5b1f0c2a-7d3e-4c91-8f62-0a1b2c3d4e5f';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const { OwnerDO } = await import('../src/channels/owner-do');
const T0 = Date.now();

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const brief = (thread: string, over: Partial<TaskBrief> = {}): TaskBrief => ({ title: 'Vendor research', goal: 'Compare the vendors.', context: 'Two vendors.', done_when: 'A pick.', effort: 'standard', timezone: 'UTC', started_at: T0, conversation_ref: `owner:prn_fixture:${thread}`, ...over });

describe('a background task\'s card in its own thread', () => {
  it('a chat 9 read carries the card the thread\'s task waits on, naming the task and the approval; chat 8 does not; deciding it clears it', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('task-thread-cards')), async (_instance, state) => {
      state.storage.kv.put('do_name', 'task-thread-cards');
      state.storage.kv.put('app_subject', String(appSubjectFor('task-thread-cards')));
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
      const call = async (method: string, path: string, body?: unknown, chat?: number) => {
        const response = await owner.fetch(new Request(`https://telegram-owner/app/v1/threads${path}`, { method, headers: { 'x-waldo-do-name': 'task-thread-cards', 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json',
          ...(chat ? { 'x-waldo-app-contract': `chat=${chat},approvals=8` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
        return response.json() as Promise<any>;
      };
      const made = async (n: number) => appThreadOperationResultV1Schema.parse(await call('POST', '', { operation_id: `0b6f3c1e-8a2d-4f5b-9c7e-${String(n).padStart(12, '0')}` }));
      const thread = (await made(1)).thread_id, other = (await made(2)).thread_id;

      // The task's held step, raised as the owner's card in the app, and the job waiting on it.
      let n = 0;
      const desk = approvalDesk(state.storage.sql, { owner: 1, surface: 'app', call: async () => ({ message_id: 1 }), google: async () => null, newId: () => `tc${++n}`, now: () => Date.now(), timezone: 'UTC', log: () => undefined,
        commit: work => state.storage.transactionSync(work), replayTaintedAction: async () => ({ status: 'done', message: '' }) });
      const args = { query: 'vendor pricing' };
      const card = await desk.proposeTaintedAction({ tool: 'web_search', args, args_digest: await sha256Hex(stableJson(args)), reasoning: 'The task needs prices.', source: 'external' });
      const book = jobBook(state.storage.sql, { now: () => Date.now(), newId: () => crypto.randomUUID().replaceAll('-', '').slice(0, 12), newToken: () => crypto.randomUUID() });
      const { job } = book.create({ kind: 'task', profile: 'reader', idempotencyKey: 'turn-1:call-1', origin: 'turn-1', surface: 'app', brief: brief(thread), dueAt: T0, deadlineAt: T0 + 3_600_000 });
      expect(book.await(book.startAttempt(job.id)!, { approval_id: card, call: { call_id: 'c1', name: 'web_search', arguments: JSON.stringify(args) } })).toBe(true);
      // A task in another thread, and one whose title was written after outside content.
      const { job: elsewhere } = book.create({ kind: 'task', profile: 'reader', idempotencyKey: 'turn-2:call-1', origin: 'turn-2', surface: 'app', brief: brief(other), dueAt: T0, deadlineAt: T0 + 3_600_000 });
      expect(book.startAttempt(elsewhere.id)).not.toBeNull();

      const read = appThreadReadV1Schema.parse(await call('GET', `/${thread}`, undefined, 9));
      expect(read.task_cards).toEqual([{ job_id: job.id, title: 'Vendor research', approval: expect.objectContaining({ type: 'approval', approval_id: card, kind: 'tainted_action' }) }]);
      expect(read.task_cards![0]!.approval.review.split('\n')[0]).toBe('Do this? Web search: The task needs prices.');
      const review = read.task_cards![0]!.approval.review;
      expect(review.slice(0, review.indexOf('Details: web_search'))).not.toContain('{');
      expect(Object.keys(appThreadReadV1Schema.parse(await call('GET', `/${thread}`, undefined, 8)))).toEqual(['thread', 'history']);
      expect(Object.keys(appThreadReadV1Schema.parse(await call('GET', `/${other}`, undefined, 9)))).toEqual(['thread', 'history']);

      await desk.decide(card, 's', 'trace', { surface: 'app' });
      expect(Object.keys(appThreadReadV1Schema.parse(await call('GET', `/${thread}`, undefined, 9)))).toEqual(['thread', 'history']);
    });
  });
});
