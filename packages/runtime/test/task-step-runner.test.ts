import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { trackResponsibilityArgsSchema, type ScheduleEntry } from '@waldo/contracts';
import { responsibilityBook, responsibilityHandlers } from '../src/channels/responsibilities';
import { stepRunner, TASK_STEP_RETRY_MS } from '../src/channels/tasks/step-runner';
import { ClosedRunError } from '../src/channels/run-effect-scope';

// The runner on real SQLite with a recording scheduler: each test drives execute() with the entries it armed, in the order a
// scheduler would deliver them.
type Book = ReturnType<typeof responsibilityBook>;
type Options = Readonly<{ send?: (text: string) => Promise<void>; step?: (prompt: string, book: Book) => Promise<string>; scheduleFails?: () => boolean }>;
type Harness = Readonly<{
  sql: SqlStorage; book: Book; runner: ReturnType<typeof stepRunner>; armed: ScheduleEntry[]; sent: string[]; prompts: string[]; now: { at: number };
  attempts: () => string[]; update: (args: object) => Promise<unknown>; track: (items: readonly object[]) => ReturnType<Book['track']>; begin: (itemId: string) => Promise<void>;
}>;
let sequence = 0;
const harness = (options: Options, body: (h: Harness) => Promise<void>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`task-step-${sequence++}`)), async (_instance, state) => {
  let n = 0;
  const now = { at: 1_000_000 };
  const sql = state.storage.sql;
  const book = responsibilityBook(sql, { newId: () => String(++n), now: () => now.at });
  const armed: ScheduleEntry[] = [], sent: string[] = [], prompts: string[] = [];
  const runner = stepRunner({
    sql, transact: work => state.storage.transactionSync(work), book, now: () => now.at, newId: () => `e${++n}`, log: () => undefined,
    scheduler: { schedule: async input => {
      if (options.scheduleFails?.()) throw new Error('schedule failed');
      const entry = { id: input.id, kind: input.kind, occurrence_at: input.occurrenceAt, due_at: input.dueAt, recurrence: null, payload_refs: input.payloadRefs, status: 'armed' as const, attempts: 0, last_fired_at: null, quarantined_until: null, created_at: 0, updated_at: 0 };
      armed.push(entry);
      return entry;
    } },
    runStep: async (_trace, prompt) => { prompts.push(prompt); return options.step ? options.step(prompt, book) : 'Found it.'; },
    send: async text => { await options.send?.(text); sent.push(text); },
  });
  const attempts = () => sql.exec<{ attempt: number; status: string; report: string | null }>('SELECT attempt, status, report FROM task_step_attempts ORDER BY rowid').toArray()
    .map(row => `${row.attempt}:${row.status}:${row.report ?? '-'}`);
  const handler = responsibilityHandlers(book, runner.armRunnable).find(entry => entry.name === 'update_todo')!;
  const update = (args: object) => (handler.handle as (args: unknown, ctx: unknown) => Promise<unknown>)(args, { trigger: 'user_message' });
  const track = (items: readonly object[]) => book.track(trackResponsibilityArgsSchema.parse({ title: 'Venue', intent: 'pick one', items }), 'user_message');
  const begin = async (itemId: string) => { expect(await runner.startBackground({ task: 'unused', itemId, revision: book.start(itemId, 'worker')!.revision })).toBe(true); };
  await body({ sql, book, runner, armed, sent, prompts, now, attempts, update, track, begin });
});

describe('the last step', () => {
  it('is not done when its result could not be sent, and runs again', async () => {
    let failures = 1;
    await harness({ send: async () => { if (failures-- > 0) throw new Error('send failed'); } }, async ({ book, runner, armed, sent, attempts, track, begin }) => {
      const { responsibility, items } = track([{ title: 'Pick the venue' }]);
      await begin(items[0]!.id);
      await runner.execute(armed.at(-1)!);
      expect(book.item(items[0]!.id)!.status).toBe('running');
      expect(book.get(responsibility.id)!.status).toBe('open');
      expect(attempts()).toEqual(['1:failed:sending', '2:armed:-']);
      await runner.execute(armed.at(-1)!);
      expect(sent).toEqual(['Found it.']);
      expect(book.get(responsibility.id)!.status).toBe('done');
    });
  });

  it('sends nothing when the owner drops the task while its turn runs', async () => {
    await harness({ step: async (_prompt, book) => { const [open] = book.list('open'); book.close({ id: open!.id, outcome: 'dropped', evidence_ref: 'owner: stop' }); return 'Found it.'; } },
      async ({ book, runner, armed, sent, attempts, track, begin }) => {
        const { responsibility, items } = track([{ title: 'Pick the venue' }]);
        await begin(items[0]!.id);
        await runner.execute(armed.at(-1)!);
        expect(sent).toEqual([]);
        expect(attempts()).toEqual(['1:cancelled:-']);
        expect(book.get(responsibility.id)!.status).toBe('dropped');
      });
  });

  it('sends nothing when the owner edits the step while its turn runs', async () => {
    await harness({ step: async (_prompt, book) => { const [item] = book.running(); book.update({ item_id: item!.id, status: 'blocked' }); return 'Found it.'; } },
      async ({ runner, armed, sent, attempts, track, begin }) => {
        const { items } = track([{ title: 'Pick the venue' }]);
        await begin(items[0]!.id);
        await runner.execute(armed.at(-1)!);
        expect(sent).toEqual([]);
        expect(attempts()).toEqual(['1:cancelled:-']);
      });
  });

  it('cut off after its result was sent is finished without sending it again', async () => {
    await harness({}, async ({ sql, book, runner, armed, sent, prompts, attempts, track, begin }) => {
      const { responsibility, items } = track([{ title: 'Pick the venue' }]);
      await begin(items[0]!.id);
      // The wake started the step, sent its result and went away before marking it done; its entry is delivered again.
      const { revision } = book.start(items[0]!.id, 'waldo')!;
      sql.exec("UPDATE task_step_attempts SET status = 'running', revision = ?, report = 'sent'", revision);
      await runner.execute(armed.at(-1)!);
      expect(prompts).toEqual([]);
      expect(sent).toEqual([]);
      expect(book.get(responsibility.id)!.status).toBe('done');
      expect(attempts()).toEqual(['1:done:sent']);
    });
  });
});

describe('retries and authority', () => {
  it('waits 30 s after the first failure and 60 s after the second, then tells the owner once', async () => {
    await harness({ step: async () => { throw new Error('provider down'); } }, async ({ book, runner, armed, sent, now, attempts, track, begin }) => {
      const { items } = track([{ title: 'Pick the venue' }]);
      await begin(items[0]!.id);
      await runner.execute(armed.at(-1)!);
      expect(armed.at(-1)!.due_at - now.at).toBe(TASK_STEP_RETRY_MS);
      await runner.execute(armed.at(-1)!);
      expect(armed.at(-1)!.due_at - now.at).toBe(2 * TASK_STEP_RETRY_MS);
      await runner.execute(armed.at(-1)!);
      expect(sent).toEqual(['I couldn\'t finish "Venue": the step "Pick the venue" failed 3 times, so I stopped.']);
      expect(book.item(items[0]!.id)!.status).toBe('failed');
      expect(attempts()).toEqual(['1:failed:-', '2:failed:-', '3:failed:sent']);
      // A repeat delivery of the attempt that gave up says nothing more.
      await runner.execute(armed.at(-1)!);
      expect(sent).toHaveLength(1);
    });
  });

  it('an attempt cut off past the last one gives up, and says so once even when delivered again', async () => {
    await harness({}, async ({ sql, book, runner, armed, sent, prompts, track, begin }) => {
      const { items } = track([{ title: 'Pick the venue' }]);
      await begin(items[0]!.id);
      const { revision } = book.start(items[0]!.id, 'waldo')!;
      sql.exec("UPDATE task_step_attempts SET attempt = 3, status = 'running', revision = ?", revision);
      await runner.execute(armed.at(-1)!);
      await runner.execute(armed.at(-1)!);
      expect(prompts).toEqual([]);
      expect(book.item(items[0]!.id)!.status).toBe('failed');
      expect(sent).toEqual(['I couldn\'t finish "Venue": the step "Pick the venue" failed 3 times, so I stopped.']);
    });
  });

  it('a closed authority at the send spends no attempt, and the waiting attempt runs once', async () => {
    let failures = 1;
    await harness({ send: async () => { if (failures-- > 0) throw new ClosedRunError(); } }, async ({ runner, armed, sent, attempts, track, begin }) => {
      const { items } = track([{ title: 'Pick the venue' }]);
      await begin(items[0]!.id);
      await runner.execute(armed.at(-1)!);
      expect(attempts()).toEqual(['1:armed:sending']);
      expect(armed).toHaveLength(2);
      // Whichever entry for that attempt is delivered first runs it; the other finds it settled.
      await runner.execute(armed[1]!);
      await runner.execute(armed[0]!);
      expect(attempts()).toEqual(['1:done:sent']);
      expect(sent).toEqual(['Found it.']);
    });
  });

  it('an entry for an attempt already replaced runs nothing', async () => {
    await harness({ step: async () => { throw new Error('provider down'); } }, async ({ runner, armed, prompts, attempts, track, begin }) => {
      const { items } = track([{ title: 'Pick the venue' }]);
      await begin(items[0]!.id);
      await runner.execute(armed[0]!);
      expect(attempts()).toEqual(['1:failed:-', '2:armed:-']);
      // The first entry delivered again (a crash before the scheduler settled it) finds attempt 2 armed, not its own.
      await runner.execute(armed[0]!);
      expect(prompts).toHaveLength(1);
      expect(attempts()).toEqual(['1:failed:-', '2:armed:-']);
    });
  });
});

describe('the owner changing a step', () => {
  it('fences an armed attempt when the step is set back to pending, and runs it again at the new revision', async () => {
    await harness({}, async ({ book, runner, armed, prompts, attempts, update, track, begin }) => {
      const { items } = track([{ title: 'Pick the venue' }]);
      await begin(items[0]!.id);
      const stale = armed.at(-1)!;
      await update({ item_id: items[0]!.id, status: 'pending' });
      expect(attempts()).toEqual(['1:cancelled:-', '2:armed:-']);
      await runner.execute(stale);
      expect(prompts).toEqual([]);
      await runner.execute(armed.at(-1)!);
      expect(prompts).toHaveLength(1);
      expect(book.item(items[0]!.id)!.status).toBe('done');
    });
  });

  it('fences an armed attempt whose step the owner changed without re-arming it', async () => {
    await harness({}, async ({ book, runner, armed, prompts, attempts, track, begin }) => {
      const { items } = track([{ title: 'Pick the venue' }]);
      await begin(items[0]!.id);
      book.update({ item_id: items[0]!.id, status: 'running' });
      await runner.execute(armed.at(-1)!);
      expect(prompts).toEqual([]);
      expect(attempts()).toEqual(['1:cancelled:-']);
    });
  });

  it('a step reset to pending after it failed gets a fresh round of attempts', async () => {
    let failing = true;
    await harness({ step: async () => { if (failing) throw new Error('provider down'); return 'Found it.'; } }, async ({ book, runner, armed, sent, attempts, update, track, begin }) => {
      const { items } = track([{ title: 'Pick the venue' }]);
      await begin(items[0]!.id);
      for (let attempt = 0; attempt < 3; attempt++) await runner.execute(armed.at(-1)!);
      expect(book.item(items[0]!.id)!.status).toBe('failed');
      failing = false;
      await update({ item_id: items[0]!.id, status: 'pending' });
      expect(attempts().at(-1)).toBe('4:armed:-');
      await runner.execute(armed.at(-1)!);
      expect(book.item(items[0]!.id)!.status).toBe('done');
      expect(sent.at(-1)).toBe('Found it.');
    });
  });

  it('in a background task, the owner finishing their step starts the Waldo step waiting on it; a task never backgrounded is left alone', async () => {
    await harness({}, async ({ book, runner, armed, update, track, begin }) => {
      const quiet = book.track(trackResponsibilityArgsSchema.parse({ title: 'Plan', intent: 'later', items: [{ title: 'Confirm', owner: 'owner' }, { title: 'Book', depends_on: [0] }] }), 'user_message');
      await update({ item_id: quiet.items[0]!.id, status: 'done', result: 'ok' });
      expect(armed).toEqual([]);
      const { items } = track([{ title: 'Find venues' }, { title: 'Confirm headcount', owner: 'owner', depends_on: [0] }, { title: 'Pick the venue', depends_on: [1] }]);
      await begin(items[0]!.id);
      await runner.execute(armed.at(-1)!);
      expect(armed).toHaveLength(1);
      await update({ item_id: items[1]!.id, status: 'done', result: '40 people' });
      expect(armed.at(-1)!.payload_refs).toEqual({ item_id: items[2]!.id, attempt_id: '1' });
    });
  });
});

describe('a schedule write that fails', () => {
  it('after a step finished: the redelivered entry arms the next step', async () => {
    let fail = false;
    await harness({ scheduleFails: () => fail }, async ({ runner, armed, track, begin }) => {
      const { items } = track([{ title: 'Find venues' }, { title: 'Pick the venue', depends_on: [0] }]);
      await begin(items[0]!.id);
      const first = armed.at(-1)!;
      fail = true;
      await expect(runner.execute(first)).rejects.toThrow('schedule failed');
      fail = false;
      await runner.execute(first);
      expect(armed.at(-1)!.payload_refs).toEqual({ item_id: items[1]!.id, attempt_id: '1' });
    });
  });

  it('while re-arming a failed attempt: the attempt stays running and the redelivered entry starts a fresh one', async () => {
    let fail = false, failing = true;
    await harness({ scheduleFails: () => fail, step: async () => { if (failing) { fail = true; throw new Error('provider down'); } return 'Found it.'; } },
      async ({ runner, armed, sent, attempts, track, begin }) => {
        const { items } = track([{ title: 'Pick the venue' }]);
        await begin(items[0]!.id);
        const first = armed.at(-1)!;
        await expect(runner.execute(first)).rejects.toThrow('schedule failed');
        expect(attempts()).toEqual(['1:running:-']);
        fail = false; failing = false;
        await runner.execute(first);
        expect(attempts()).toEqual(['1:interrupted:-', '2:done:sent']);
        expect(sent).toEqual(['Found it.']);
      });
  });

  it('at the first arm: the background start reports that it did not start', async () => {
    await harness({ scheduleFails: () => true }, async ({ book, runner, attempts, track }) => {
      const { items } = track([{ title: 'Pick the venue' }]);
      expect(await runner.startBackground({ task: 'unused', itemId: items[0]!.id, revision: book.start(items[0]!.id, 'worker')!.revision })).toBe(false);
      expect(attempts()).toEqual([]);
    });
  });
});
