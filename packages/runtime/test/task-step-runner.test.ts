import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { trackResponsibilityArgsSchema, type ScheduleEntry } from '@waldo/contracts';
import { responsibilityBook, responsibilityHandlers } from '../src/channels/responsibilities';
import { stepRunner } from '../src/channels/tasks/step-runner';
import { ClosedRunError } from '../src/channels/run-effect-scope';

// The runner's send seam: what the owner hears, and what happens to the step when that send fails.
let sequence = 0;
type Harness = Readonly<{ book: ReturnType<typeof responsibilityBook>; runner: ReturnType<typeof stepRunner>; armed: ScheduleEntry[]; attempts: () => string[] }>;
const harness = (send: (text: string) => Promise<void>, body: (h: Harness) => Promise<void>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`task-step-${sequence++}`)), async (_instance, state) => {
  let n = 0;
  const book = responsibilityBook(state.storage.sql, { newId: () => String(++n), now: Date.now });
  const armed: ScheduleEntry[] = [];
  const runner = stepRunner({
    sql: state.storage.sql, transact: work => state.storage.transactionSync(work), book, now: Date.now, newId: () => `e${++n}`, log: () => undefined,
    scheduler: { schedule: async input => { const entry = { id: input.id, kind: input.kind, occurrence_at: input.occurrenceAt, due_at: input.dueAt, recurrence: null, payload_refs: input.payloadRefs, status: 'armed' as const, attempts: 0, last_fired_at: null, quarantined_until: null, created_at: 0, updated_at: 0 }; armed.push(entry); return entry; } },
    runStep: async () => 'The Hall is best.',
    send,
  });
  const attempts = () => state.storage.sql.exec<{ attempt: number; status: string }>('SELECT attempt, status FROM task_step_attempts ORDER BY rowid').toArray().map(row => `${row.attempt}:${row.status}`);
  await body({ book, runner, armed, attempts });
});

it('a last step whose result could not be sent is not done, and runs again', async () => {
  let failures = 1;
  const sent: string[] = [];
  await harness(async text => { if (failures-- > 0) throw new Error('send failed'); sent.push(text); }, async ({ book, runner, armed, attempts }) => {
  const { responsibility, items } = book.track(trackResponsibilityArgsSchema.parse({ title: 'Venue', intent: 'pick one', items: [{ title: 'Pick the venue' }] }), 'user_message');
  expect(await runner.startBackground({ task: 'pick', itemId: items[0]!.id, revision: items[0]!.revision })).toBe(true);
  await runner.execute(armed.at(-1)!);
  expect(book.item(items[0]!.id)!.status).toBe('running');
  expect(book.get(responsibility.id)!.status).toBe('open');
  expect(attempts()).toEqual(['1:failed', '2:armed']);
  await runner.execute(armed.at(-1)!);
  expect(sent).toEqual(['The Hall is best.']);
  expect(book.item(items[0]!.id)!.status).toBe('done');
  expect(book.get(responsibility.id)!.status).toBe('done');
  });
});

it('a closed authority at the send spends no attempt, and the waiting attempt runs once', async () => {
  let failures = 1, sends = 0;
  await harness(async () => { sends += 1; if (failures-- > 0) throw new ClosedRunError(); }, async ({ book, runner, armed, attempts }) => {
    const { items } = book.track(trackResponsibilityArgsSchema.parse({ title: 'Venue', intent: 'pick one', items: [{ title: 'Pick the venue' }] }), 'user_message');
    await runner.startBackground({ task: 'pick', itemId: items[0]!.id, revision: items[0]!.revision });
    await runner.execute(armed.at(-1)!);
    expect(attempts()).toEqual(['1:armed']);
    expect(armed).toHaveLength(2);
    // Whichever entry for that attempt is delivered first runs it; the other finds it settled.
    await runner.execute(armed[1]!);
    await runner.execute(armed[0]!);
    expect(attempts()).toEqual(['1:done']);
    expect(sends).toBe(2);
  });
});

it('an update to an owner step starts the Waldo step waiting on it', async () => {
  await harness(async () => undefined, async ({ book, runner, armed }) => {
  const { items } = book.track(trackResponsibilityArgsSchema.parse({ title: 'Offsite', intent: 'book it', items: [{ title: 'Confirm headcount', owner: 'owner' }, { title: 'Pick the venue', depends_on: [0] }] }), 'user_message');
  const update = responsibilityHandlers(book, runner.armRunnable).find(handler => handler.name === 'update_todo')!;
  await (update.handle as (args: unknown, ctx: unknown) => Promise<unknown>)({ item_id: items[0]!.id, status: 'done', result: '40 people' }, { trigger: 'user_message' });
  expect(armed.map(entry => entry.payload_refs)).toEqual([{ item_id: items[1]!.id, attempt_id: '1' }]);
  });
});
