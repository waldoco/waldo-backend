import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { NIGHTLY_SOURCES_THROUGH_KEY } from '../src/channels/nightly-sources';
import { claimStore, turnMemoryPrompt } from '../src/memory/claims';
import { MEMORY_DAYTIME_ID } from '../src/memory/consolidator';
import { recallForTurn } from '../src/memory/turn-recall';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// The daytime consolidator through the owner object as it runs: the update sweep records a 09:00 mail and calendar change,
// its hint arms one pass and does nothing else, and the pass, when the owner's alarm runs it, turns the changes into untrusted
// candidates the same day. Synthetic fixtures only; the one health reading is made up.
const NINE = Date.parse('2026-10-31T09:00:00Z');
const fixture = vi.hoisted(() => ({ mail: [] as unknown[], calendar: [] as unknown[] }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (...args: Parameters<typeof original.googleClient>) => args[0].clientId !== 'daytime-fixture' ? original.googleClient(...args) : ({
    changedEvents: async () => fixture.calendar, newMail: async () => fixture.mail, events: async () => [],
  }) };
});
const model = vi.hoisted(() => ({ sources: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format?.name === 'source_claims') {
      model.sources.push(JSON.stringify(request.messages));
      const add = (text: string, evidence: string, kind = 'fact') => ({ kind, text, source: 'stated', evidence, touches_forgotten: false, aliases: [], aliases_touch_forgotten: false });
      return done(JSON.stringify({ add: [add('Has a design review with Asha on Friday', 'Design review Friday'), add('Resting heart rate is 48', '"resting heart rate 48"', 'health')] }));
    }
    return done('SKIP');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

beforeEach(() => { fixture.mail = []; fixture.calendar = []; model.sources = []; });
afterEach(() => { vi.restoreAllMocks(); });

type Flags = Readonly<{ daytime?: string; sources?: string }>;
type Run = Readonly<{ state: DurableObjectState; scheduler: Scheduler; clock: { at: number }; sweep(trace: string): Promise<void>; wake(at: number): Promise<void> }>;
const withOwner = (name: string, flags: Flags, work: (run: Run) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const realNow = Date.now;
    const clock = { at: NINE };
    Date.now = () => clock.at;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      ensureSchema(state.storage);
      state.storage.kv.put('telegram_subject', '7');
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'fixture', scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.readonly'] }]);
      claimStore(state.storage.sql).add({ kind: 'fact', text: 'Lives in Pune', source: 'stated', evidence: '"I live in Pune"', origin: 'owner', source_ref: 'owner, tg-1' }, new Date(NINE - 86_400_000).toISOString());
      const owner = new OwnerDO(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:fixture', OPENAI_API_KEY: 'fixture', GOOGLE_CLIENT_ID: 'daytime-fixture', GOOGLE_CLIENT_SECRET: 'fixture',
        MEMORY_DAYTIME_CONSOLIDATOR: flags.daytime, MEMORY_NIGHTLY_SOURCE_UPDATES: flags.sources });
      const runtime = (owner as unknown as { setup(): { ready: Promise<unknown>; updateCheck(trace: string): Promise<void> } }).setup();
      await runtime.ready;
      state.storage.sql.exec('DELETE FROM schedule');
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      const wake = async (at: number) => { clock.at = at; state.storage.kv.put('owner_alarm_last_v1', 1); await owner.alarm(); };
      await runtime.updateCheck('seed');
      await work({ state, scheduler, clock, sweep: (trace) => runtime.updateCheck(trace), wake });
    } finally { Date.now = realNow; await state.storage.deleteAlarm(); }
  });
const mailFromAsha = () => { fixture.mail = [{ thread_id: 't9', id: 'm1', from: 'Asha <asha@example.com>', subject: 'Design review Friday; resting heart rate 48 from the watch', snippet: 'Can we do Friday?', at: '2026-10-31T09:00:00Z' }]; };
const armedAt = (scheduler: Scheduler) => { const found = scheduler.lookup(MEMORY_DAYTIME_ID); return found.state === 'entry' ? found.entry.due_at : null; };
const runs = (state: DurableObjectState) => state.storage.sql.exec<{ kind: string; status: string; summary: string }>("SELECT kind, status, summary FROM background_runs WHERE kind = 'memory_daytime'").toArray();
const ON: Flags = { daytime: '1', sources: '1' };

it('a 09:00 mail is an untrusted candidate the same morning; the hint only armed the pass', async () => {
  await withOwner('memory-daytime-golden', ON, async ({ state, scheduler, clock, sweep, wake }) => {
    mailFromAsha();
    await sweep('changed');
    // The hint wrote one schedule row and nothing else: no model call, no read of the changes, no mark.
    expect(armedAt(scheduler)).toBe(NINE);
    expect(model.sources).toEqual([]);
    expect(state.storage.kv.get(NIGHTLY_SOURCES_THROUGH_KEY)).toBeUndefined();
    await wake(clock.at + 1_000);
    expect(model.sources).toHaveLength(1);
    expect(model.sources[0]).toContain('Design review Friday');
    expect(model.sources[0]).toContain('outside content');
    const written = claimStore(state.storage.sql).claims().filter((claim) => claim.text !== 'Lives in Pune');
    expect(written.map((claim) => [claim.text, claim.origin])).toEqual([['Has a design review with Asha on Friday', 'untrusted']]);
    expect(written[0]!.verification_status).not.toBe('owner-grounded');
    // A health number that arrived in outside content is never written to memory from that path.
    expect(JSON.stringify(claimStore(state.storage.sql).allClaims())).not.toContain('48');
    // A candidate is not the owner's word: it is in no turn's core and no recall.
    expect(turnMemoryPrompt(claimStore(state.storage.sql), 'design review Asha Friday')).not.toContain('design review with Asha');
    expect((await recallForTurn({ claims: claimStore(state.storage.sql), question: 'design review Asha Friday', room: 100_000, holds: () => false })).text).not.toContain('design review with Asha');
    expect(runs(state)).toEqual([{ kind: 'memory_daytime', status: 'completed', summary: 'read the new mail and calendar changes' }]);
    expect(armedAt(scheduler)).toBeNull();
  });
});

it.each([
  ['the daytime flag off', { daytime: '0', sources: '1' }],
  ['the source pass off', { daytime: '1', sources: '0' }],
] as const)('with %s, a change arms nothing, and a pass already armed makes no call', async (_label, flags) => {
  await withOwner(`memory-daytime-${flags.daytime}-${flags.sources}`, flags, async ({ state, scheduler, clock, sweep, wake }) => {
    mailFromAsha();
    await sweep('changed');
    expect(armedAt(scheduler)).toBeNull();
    await scheduler.schedule({ id: MEMORY_DAYTIME_ID, kind: 'dreaming', payloadRefs: { id: MEMORY_DAYTIME_ID }, occurrenceAt: clock.at, dueAt: clock.at, recurrence: null });
    await wake(clock.at + 1_000);
    expect(model.sources).toEqual([]);
    expect(runs(state)).toEqual([]);
  });
});

it('an owner who turned the memory pass off gets no daytime pass either', async () => {
  await withOwner('memory-daytime-pref-off', ON, async ({ state, scheduler, clock, sweep, wake }) => {
    state.storage.sql.exec("INSERT OR REPLACE INTO schedule_preferences (kind, enabled) VALUES ('nightly', 0)");
    mailFromAsha();
    await sweep('changed');
    expect(armedAt(scheduler)).toBeNull();
    await scheduler.schedule({ id: MEMORY_DAYTIME_ID, kind: 'dreaming', payloadRefs: { id: MEMORY_DAYTIME_ID }, occurrenceAt: clock.at, dueAt: clock.at, recurrence: null });
    await wake(clock.at + 1_000);
    expect(model.sources).toEqual([]);
    expect(armedAt(scheduler)).toBeNull();
  });
});
