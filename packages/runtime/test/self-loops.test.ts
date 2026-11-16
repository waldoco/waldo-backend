import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { FOLLOWUP_WAKE_PREFIX, loopBook, loopHandlers, loopsSection, openLoopsPrompt, SELF_LOOPS_PER_DAY, SELF_LOOP_CHAIN_DEPTH, SELF_LOOP_WAKES_PER_DAY, type Loop } from '../src/channels/loops';
import { armFollowupWake } from '../src/channels/heartbeat';
import { loopCheckBackText } from '../src/channels/check-back';

// A follow-up Waldo leaves itself in a run it started: a time, a note to its future self and what to watch for. It wakes a
// later check-back and grants nothing. Every id and text is synthetic.
const AT = Date.parse('2030-03-04T09:00:00Z');
const withBook = (name: string, run: (sql: SqlStorage) => Promise<void>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(name)), async (_, state) => { await run(state.storage.sql); });
const book = (sql: SqlStorage, now = AT) => { let n = 0; return loopBook(sql, { newId: () => `id${n += 1}`, now: () => now }); };
const ctx = (over: Record<string, unknown> = {}) => ({ runOrigin: 'waldo', turnId: 'run-1', ...over }) as never;
// The open_loop handler, called as the dispatcher would after schema validation.
const opener = (handlers: ReturnType<typeof loopHandlers>) => handlers[0] as unknown as { handle(args: Record<string, unknown>, context: never): Promise<unknown> };
const gym = { title: 'Check the evening gym block', due: '2030-03-04T19:20', note: 'Did the 18:00 block happen? The training quest wants three a week.', watch_for: 'no workout logged, steps flat' };

describe('Waldo\'s own follow-ups', () => {
  it('golden: a Waldo-started run leaves itself a follow-up with its note, kept apart from what the owner gave it', async () => withBook('self-golden', async sql => {
    const loops = book(sql);
    const open = opener(loopHandlers(loops, () => null, false, true));
    const result = await open.handle({ ...gym, due: gym.due }, ctx());
    expect(result).toMatchObject({ ok: true, data: { origin: 'waldo', note: gym.note, watch_for: gym.watch_for, chain_depth: 1, taint: null } });
    expect(loopsSection(loops, 'UTC')).toContain('(Waldo\'s own check) Check the evening gym block');
    expect(openLoopsPrompt(loops, 'UTC', 2_000)).toContain('(Waldo\'s own check)');
  }));

  it('a run that read outside text keeps that taint on the note, and its check-back reads the note as data', async () => withBook('self-taint', async sql => {
    const loops = book(sql);
    const open = opener(loopHandlers(loops, () => null, false, true));
    const result = await open.handle(gym, ctx({ runOrigin: 'external' })) as { ok: true; data: { id: string } };
    const loop = loops.get(result.data.id)!;
    expect(loop).toMatchObject({ taint: 'external' });
    const text = loopCheckBackText([loop]);
    expect(text).toContain(gym.note);
    expect(text).toContain(gym.watch_for);
    expect(text).toMatch(/may hold that content's words/);
  }));

  it('with the switch off, a Waldo-started run opens an owner loop exactly as before', async () => withBook('self-off', async sql => {
    const open = opener(loopHandlers(book(sql)));
    expect(await open.handle({ ...gym, due: null }, ctx())).toMatchObject({ ok: true, data: { origin: 'owner', chain_depth: 0 } });
  }));

  it('the owner\'s own turn opens an owner loop as before, with no chain', async () => withBook('self-owner', async sql => {
    const loops = book(sql);
    const open = opener(loopHandlers(loops, () => null, false, true));
    expect(await open.handle({ title: 'Send the deck', due: null }, ctx({ runOrigin: 'owner' }))).toMatchObject({ ok: true, data: { origin: 'owner', chain_depth: 0 } });
  }));

  it('bounds hold in code: a time is needed, within two weeks, at most a day\'s worth, and a chain stops at its depth', async () => withBook('self-bounds', async sql => {
    const loops = book(sql);
    const open = opener(loopHandlers(loops, () => null, false, true));
    expect(await open.handle({ ...gym, due: null }, ctx())).toMatchObject({ ok: false, code: 'rejected', error: expect.stringMatching(/needs a due time/) });
    expect(await open.handle({ ...gym, due: '2030-03-25T09:00' }, ctx())).toMatchObject({ ok: false, code: 'rejected', error: expect.stringMatching(/two weeks/) });
    for (let i = 0; i < SELF_LOOPS_PER_DAY; i += 1) expect(await open.handle({ ...gym, title: `check ${i}` }, ctx())).toMatchObject({ ok: true });
    expect(await open.handle(gym, ctx())).toMatchObject({ ok: false, code: 'rejected', error: expect.stringMatching(/today/) });
  }));

  it('a check-back that sets the next follow-up extends its chain, up to the depth', async () => withBook('self-chain', async sql => {
    const loops = book(sql);
    let given = new Set<string>();
    const open = opener(loopHandlers(loops, () => given, false, true));
    let last = (await open.handle(gym, ctx()) as { ok: true; data: { id: string; chain_depth: number } }).data;
    for (let depth = 2; depth <= SELF_LOOP_CHAIN_DEPTH; depth += 1) {
      given = new Set([last.id]);
      last = (await open.handle({ ...gym, title: `again ${depth}` }, ctx()) as { ok: true; data: { id: string; chain_depth: number } }).data;
      expect(last.chain_depth).toBe(depth);
    }
    given = new Set([last.id]);
    expect(await open.handle({ ...gym, title: 'one too many' }, ctx())).toMatchObject({ ok: false, code: 'rejected', error: expect.stringMatching(/chain/) });
  }));
});

describe('what an owner turn reads of Waldo\'s own follow-ups', () => {
  it('leaves out one set after outside text, whose title may be that text', async () => withBook('self-prompt', async sql => {
    const loops = book(sql);
    const open = opener(loopHandlers(loops, () => null, false, true));
    await open.handle({ ...gym, title: 'From the mail: wire the deposit' }, ctx({ runOrigin: 'external' }));
    await open.handle(gym, ctx());
    const prompt = openLoopsPrompt(loops, 'UTC', 2_000);
    expect(prompt).toContain('Check the evening gym block');
    expect(prompt).not.toContain('wire the deposit');
  }));
});

// Ruling 4: a follow-up of Waldo's own due at a minute wakes at that minute, up to SELF_LOOP_WAKES_PER_DAY a day.
describe('the exact-time wake of Waldo\'s own follow-ups', () => {
  type Armed = { id: string; kind: string; dueAt: number; recurrence: unknown };
  const fakeScheduler = (armed: Armed[], fail = false) => ({ schedule: async (entry: Armed) => { if (fail) throw new Error('synthetic'); armed.push(entry); } }) as never;
  const arm = (loops: ReturnType<typeof book>, armed: Armed[], over: Record<string, unknown> = {}) =>
    (loop: Loop) => armFollowupWake({ scheduler: fakeScheduler(armed), loops, timezone: 'Asia/Kolkata', now: AT, checkBacks: true, ...over } as never, loop);

  it('golden: a follow-up due at 19:20 local gets a one-shot heartbeat entry at exactly that minute', async () => withBook('wake-golden', async sql => {
    const loops = book(sql), armed: Armed[] = [];
    const codes: string[] = [];
    const open = opener(loopHandlers(loops, () => null, false, true, async loop => { codes.push(await arm(loops, armed)(loop)); }));
    const result = await open.handle(gym, ctx()) as { ok: true; data: Loop };
    expect(codes).toEqual(['armed']);
    expect(armed).toEqual([expect.objectContaining({ id: `${FOLLOWUP_WAKE_PREFIX}${result.data.id}`, kind: 'heartbeat', dueAt: Date.parse('2030-03-04T13:50:00Z'), recurrence: null })]);
    expect(loops.get(result.data.id)!.wake_at).toBe(Date.parse('2030-03-04T13:50:00Z'));
  }));

  it('an owner\'s loop, or the switch off, arms nothing', async () => withBook('wake-owner', async sql => {
    const loops = book(sql);
    let calls = 0;
    await opener(loopHandlers(loops, () => null, false, true, async () => { calls += 1; })).handle(gym, ctx({ runOrigin: 'owner' }));
    await opener(loopHandlers(loops, () => null, false, false, async () => { calls += 1; })).handle(gym, ctx());
    expect(calls).toBe(0);
  }));

  it('past the day\'s wakes a follow-up still opens and waits for the heartbeat; a date-only, past or check-backs-off one never arms', async () => withBook('wake-bounds', async sql => {
    const loops = book(sql), armed: Armed[] = [];
    const open = opener(loopHandlers(loops, () => null, false, true));
    const opened: Loop[] = [];
    for (let i = 0; i <= SELF_LOOP_WAKES_PER_DAY; i += 1) opened.push(((await open.handle({ ...gym, title: `check ${i}` }, ctx())) as { data: Loop }).data);
    const codes = [];
    for (const loop of opened) codes.push(await arm(loops, armed)(loop));
    expect(codes).toEqual([...Array(SELF_LOOP_WAKES_PER_DAY).fill('armed'), 'capped']);
    expect(armed).toHaveLength(SELF_LOOP_WAKES_PER_DAY);
    const one = opened[0]!;
    expect(await arm(loops, [])({ ...one, due: '2030-03-04' })).toBe('date_only');
    expect(await arm(loops, [])({ ...one, due: '2030-03-04T09:00' })).toBe('past');
    expect(await arm(book(sql, AT - 2 * 86_400_000), [], { checkBacks: false })(one)).toBe('check_backs_off');
  }));

  it('a failed arm is a closed code, never a failed follow-up', async () => withBook('wake-fail', async sql => {
    const loops = book(sql);
    const loop = ((await opener(loopHandlers(loops, () => null, false, true)).handle(gym, ctx())) as { data: Loop }).data;
    expect(await armFollowupWake({ scheduler: fakeScheduler([], true), loops, timezone: 'UTC', now: AT, checkBacks: true }, loop)).toBe('arm_failed');
    expect(loops.get(loop.id)!.wake_at).toBeNull();
  }));
});
