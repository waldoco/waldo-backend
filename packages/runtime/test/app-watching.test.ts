import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { watchingChangeV1Schema, watchingListV1Schema } from '../../contracts/src/app/watching';
import { APP_WATCHING_CLOSE_PATH, APP_WATCHING_MOVE_PATH, APP_WATCHING_PATH, appWatchingRequest } from '../src/channels/app-watching';
import { loopBook } from '../src/channels/loops';

// "What I'm keeping an eye on": Waldo's own follow-ups, listed for the app, closed or moved by the owner. Every title is synthetic.
const NOW = Date.parse('2030-03-04T03:30:00Z');
const ZONE = 'Asia/Kolkata';
let seq = 0;
const withLoops = (work: (h: Readonly<{ loops: ReturnType<typeof loopBook>; call(path: string, body?: unknown, method?: string): Promise<{ status: number; body: any }> }>) => Promise<void>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`app-watching-${seq += 1}`)), async (_instance, state) => {
    let n = 0;
    const loops = loopBook(state.storage.sql, { newId: () => `id${n += 1}`, now: () => NOW });
    const call = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
      const response = await appWatchingRequest(new Request(`https://owner${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
        { loops, timezone: ZONE, now: () => NOW, assertCurrent: async () => undefined });
      return { status: response.status, body: await response.json() };
    };
    await work({ loops, call });
  });
const own = (loops: ReturnType<typeof loopBook>, title: string, due: string, extra: Record<string, unknown> = {}, taint: 'external' | null = null) =>
  loops.open({ title, due, ...extra } as never, { origin: 'waldo', taint, chainDepth: 1 });

describe('the watching list', () => {
  it('golden: Waldo\'s own open follow-ups in due order, each with its why and its instant, and nothing of the owner\'s', async () => withLoops(async ({ loops, call }) => {
    own(loops, 'Check the evening gym block', '2030-03-04T19:20', { note: 'Did the 18:00 block happen?' });
    own(loops, 'Look at the quote reply', '2030-03-04T12:00', {}, 'external');
    loops.open({ title: 'Send the deck', due: '2030-03-04T10:00' });
    const { status, body } = await call(APP_WATCHING_PATH);
    expect(status).toBe(200);
    expect(watchingListV1Schema.parse(body).items).toEqual([
      { id: 'loop:2', title: 'Look at the quote reply', why: 'Waldo set this to look again.', due_at: '2030-03-04T06:30:00.000Z', source: 'planning', from_outside: true },
      { id: 'loop:1', title: 'Check the evening gym block', why: 'Did the 18:00 block happen?', due_at: '2030-03-04T13:50:00.000Z', source: 'planning', from_outside: false },
    ]);
  }));

  it('an empty list, a query and a wrong method', async () => withLoops(async ({ call }) => {
    expect(await call(APP_WATCHING_PATH)).toEqual({ status: 200, body: { items: [] } });
    expect((await call(`${APP_WATCHING_PATH}?all=1`)).status).toBe(400);
    expect((await call(APP_WATCHING_PATH, {}, 'POST')).status).toBe(405);
  }));
});

describe('closing and moving one', () => {
  it('golden: "don\'t bother" closes it, and the same request again answers closed without changing anything', async () => withLoops(async ({ loops, call }) => {
    const loop = own(loops, 'Check the evening gym block', '2030-03-04T19:20');
    const first = await call(APP_WATCHING_CLOSE_PATH, { request_id: 'req_fixture_1', id: 'loop:1' });
    expect(first).toEqual({ status: 200, body: { request_id: 'req_fixture_1', id: 'loop:1', state: 'closed' } });
    expect(loops.get(loop.id)!.status).toBe('dropped');
    expect(await call(APP_WATCHING_CLOSE_PATH, { request_id: 'req_fixture_1', id: 'loop:1' })).toEqual(first);
    expect((await call(APP_WATCHING_PATH)).body.items).toEqual([]);
  }));

  it('golden: a move lands on the owner\'s minute and answers the instant it took', async () => withLoops(async ({ loops, call }) => {
    const loop = own(loops, 'Check the evening gym block', '2030-03-04T19:20');
    const moved = await call(APP_WATCHING_MOVE_PATH, { request_id: 'req_fixture_2', id: 'loop:1', due_at: '2030-03-05T02:30:20.000Z' });
    expect(moved.status).toBe(200);
    expect(watchingChangeV1Schema.parse(moved.body)).toEqual({ request_id: 'req_fixture_2', id: 'loop:1', state: 'moved', due_at: '2030-03-05T02:30:00.000Z' });
    expect(loops.get(loop.id)!.due).toBe('2030-03-05T08:00');
  }));

  it('refuses a move to the past or past two weeks, a closed one, an owner\'s loop and a malformed request', async () => withLoops(async ({ loops, call }) => {
    own(loops, 'Check the evening gym block', '2030-03-04T19:20');
    loops.open({ title: 'Send the deck', due: '2030-03-04T10:00' });
    expect((await call(APP_WATCHING_MOVE_PATH, { request_id: 'req_fixture_3', id: 'loop:1', due_at: '2030-03-04T03:00:00Z' })).body).toEqual({ error: 'invalid_due' });
    expect((await call(APP_WATCHING_MOVE_PATH, { request_id: 'req_fixture_3', id: 'loop:1', due_at: '2030-03-19T04:00:00Z' })).body).toEqual({ error: 'invalid_due' });
    expect((await call(APP_WATCHING_CLOSE_PATH, { request_id: 'req_fixture_4', id: 'loop:2' })).status).toBe(404);
    expect((await call(APP_WATCHING_CLOSE_PATH, { request_id: 'short', id: 'loop:1' })).status).toBe(400);
    await call(APP_WATCHING_CLOSE_PATH, { request_id: 'req_fixture_5', id: 'loop:1' });
    expect(await call(APP_WATCHING_MOVE_PATH, { request_id: 'req_fixture_6', id: 'loop:1', due_at: '2030-03-05T02:30:00Z' })).toEqual({ status: 409, body: { error: 'closed' } });
  }));
});
