import { ownerTyped } from './helpers/owner-typed';
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toContextHealthMaterial, type HealthContextRow } from '../src/channels/health-context';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { renderHealth } from '../src/context-composer/prompt';
import { ownerMessageAdmission } from '../src/identity/owner-message-admission';
import { scrubTraceHealth } from '../src/observability/trace-health-scrub';
import { numericHealthIn, redactNumericHealth } from '../src/scribe/sanitiser';

type Body = { instructions?: string; input?: string | ReadonlyArray<{ role: string; content: unknown }> };
const seen = vi.hoisted(() => ({ bodies: [] as Body[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: Body) => {
  seen.bodies.push(body);
  return { id: 'fixture', output_text: 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
beforeEach(() => { seen.bodies = []; });

// Synthetic values only. Each number below is distinctive, so a leak anywhere in a prompt is found by its digits.
const clock = { timezone: 'UTC', now: () => new Date() };
const today = new Date().toISOString().slice(0, 10);
const baseline = (state: string, personal_days: number) => ({ state, personal_days, needed: 14, prior: 'adults' });
const SEEDED = ['41.37', '73.58', '81.29', '0.617', '642.5'] as const;
const WINDOW_LINE = 'Energy windows today (their local time): peak 09:30–11:30.';
const seededRow = (extra: Record<string, unknown> = {}): HealthContextRow => ({
  context: {
    id: 'ctx-feed', day: today,
    form: { score: 41.37, zone: 'moderate', algorithm_version: 'form.v9', activation: 'accepted', confidence: 0.617, baseline: baseline('provisional', 3) },
    recovery: { score: 73.58, zone: 'good', algorithm_version: 'recovery.v5', activation: 'accepted', confidence: 0.617, baseline: baseline('provisional', 3) },
    weight: { score: 81.29, zone: 'good', algorithm_version: 'weight.v5', activation: 'accepted', confidence: 0.617, baseline: baseline('personal', 21) },
    sleep_debt: { state: 'available', debt_minutes: 642.5, need_basis: 'own_average', algorithm_version: 'sleep-debt.v2', activation: 'accepted' },
    windows: [{ start: '09:30', end: '11:30', kind: 'peak' }],
    drivers: ['wrist temperature above usual'], confidence: 0.617, freshness: 'fresh', tags: [], compiled_at: new Date(Date.now() - 3_600_000).toISOString(),
    ...extra,
  },
  previous: null,
});
const material = (extra: Record<string, unknown> = {}) => {
  const built = toContextHealthMaterial(seededRow(extra), clock);
  expect(built).not.toBeNull();
  return built!;
};
const readNow = async (extra: Record<string, unknown> = {}) => { await new Promise(resolve => setTimeout(resolve, 5)); return material(extra); };

const ABSENT = 'No derived health context is available';
const healthBlock = (text: string): string => text.split(/\n[ \t]*\n/).find(part => /^\s*(?:Form zone:|Recovery zone:)/.test(part)) ?? '';
const clockTimes = /\d\d:\d\d/g;

describe('renderHealth tells the model what its health context is made of', () => {
  it('states the provisional pillars, sleep debt and the day\'s windows in words, in one paragraph', () => {
    const block = renderHealth(material());
    expect(block).toMatch(/^Form zone: flagging\./);
    expect(block).not.toMatch(/\n[ \t]*\n/);
    expect(block).toContain('Recovery: solid. Load: heavy.');
    expect(block).toContain('Baseline: Recovery and Form provisional: their personal baseline is still forming, so read these as a first estimate, not their settled norm. Load on their own baseline.');
    expect(block).toContain('Sleep debt: building up over recent nights.');
    expect(block).toContain(WINDOW_LINE);
  });

  it('words each baseline and each sleep-debt state, and keeps silent about what the row does not carry', () => {
    const only = (extra: Record<string, unknown>) => renderHealth(material(extra));
    expect(only({ weight: { score: 81.29, zone: 'good', algorithm_version: 'weight.v5' } })).not.toContain('Load on their own baseline');
    expect(only({ recovery: { score: 73.58, zone: 'good', algorithm_version: 'recovery.v5', baseline: baseline('personal', 30) }, form: null })).toContain('Baseline: Recovery and Load on their own baseline.');
    expect(only({ sleep_debt: { state: 'available', debt_minutes: 30, need_basis: 'own_average', algorithm_version: 'sleep-debt.v2', activation: 'accepted' } })).toContain('Sleep debt: steady, not building.');
    expect(only({ sleep_debt: { state: 'partial', confidence: 0.6, algorithm_version: 'sleep-debt.v2', activation: 'accepted' } })).toContain('Sleep debt: only partly known');
    expect(only({ sleep_debt: { state: 'unavailable', reason: 'missing_sleep' } })).toContain('Sleep debt: unknown.');
    const quiet = only({ sleep_debt: undefined, windows: undefined, form: { score: 41.37, zone: 'moderate', algorithm_version: 'form.v9' }, recovery: { score: 73.58, zone: 'good', algorithm_version: 'recovery.v5' }, weight: null });
    for (const word of ['Baseline:', 'Sleep debt', 'Energy windows']) expect(quiet).not.toContain(word);
  });

  it('renders a row without the new fields exactly as it did', () => {
    const legacy = toContextHealthMaterial({
      context: { id: 'ctx-1', day: today, form: { score: 72, zone: 'good', drivers: ['sleep below baseline'], confidence: 0.8 }, recovery: { score: 70, zone: 'good' }, weight: { score: 45, zone: 'moderate' },
        drivers: ['sleep below baseline'], confidence: 0.8, freshness: 'fresh', tags: ['travel'], compiled_at: new Date(Date.now() - 3_600_000).toISOString() },
      previous: { day: '2026-09-27', form_score: 64 },
    }, clock);
    expect(renderHealth(legacy)).toBe([
      'Form zone: steady.',
      'Trend: improving. Freshness: fresh.',
      'Confidence: high. Missing components: none.',
      'Recovery: solid. Load: moderate.',
      'Day summary: Form steady; recovery solid; load moderate. Drivers: sleep below baseline. Tags: travel.',
    ].join('\n'));
  });

  it('never prints the algorithm version, a score, a count of days or minutes', () => {
    const block = renderHealth(material());
    for (const value of [...SEEDED, 'form.v9', 'recovery.v5', 'weight.v5', 'sleep-debt', 'personal_days']) expect(block).not.toContain(value);
    expect(block.replace(clockTimes, '')).not.toMatch(/\d/);
  });
});

describe('the numeric health floor and the prompt checks take a clock-time window and still stop a reading', () => {
  const windows = ['peak 09:30–11:30', 'peak 09:30-11:30', 'peak 09:30–11:30; dip 14:00–15:30', 'dip 06:00–07:00', 'peak 20:15–22:45'];
  it('does not read a window as a measurement', () => {
    for (const window of windows) {
      const line = `Energy windows today (their local time): ${window}.`;
      expect(numericHealthIn(line), line).toBe(false);
      expect(redactNumericHealth(line, '[withheld]'), line).toBe(line);
    }
    const block = renderHealth(material());
    expect(numericHealthIn(block)).toBe(false);
    expect(redactNumericHealth(block, '[withheld]')).toBe(block);
  });

  it('still reads a reading with a number as one, beside a window or not', () => {
    for (const reading of ['Resting heart rate 61 bpm', 'resting heart rate was 61', 'HRV 48 ms', 'slept 5h 40m', 'SpO2 96%']) {
      expect(numericHealthIn(reading), reading).toBe(true);
      expect(numericHealthIn(`${WINDOW_LINE}\n${reading}`), reading).toBe(true);
      expect(redactNumericHealth(`${WINDOW_LINE}\n${reading}`, '[withheld]'), reading).toContain(WINDOW_LINE);
      expect(redactNumericHealth(`${WINDOW_LINE}\n${reading}`, '[withheld]'), reading).toContain('[withheld]');
    }
  });

  it('keeps a trace from carrying the windows or any line of the health paragraph, and keeps the rest', () => {
    const block = `Shared health today (derived by the app from the owner's own wearable data):\n${renderHealth(material())}`;
    const entry: TurnLogEntry = { trace: 'tg-feed', hop: 'llm_reply', ms: 1, ok: true, text: { input: JSON.stringify([{ role: 'user', content: `plan tomorrow around my energy\n\nTurn context:\n\n${block}\n\nClock: 13:00` }]) } };
    const text = scrubTraceHealth(entry).text!.input;
    for (const value of ['09:30', 'Energy windows', 'Sleep debt', 'Baseline:', 'provisional', 'building']) expect(text).not.toContain(value);
    for (const kept of ['plan tomorrow around my energy', 'Clock: 13:00']) expect(text).toContain(kept);
  });
});

const owner = '10000000-0000-0000-0000-000000000001';
const scope = (): RunEffectScope => ({ runId: 'run-one', attempt: 'attempt-one', deadline: Date.now() + 15 * 60_000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() });
const appContext = async (health: boolean, text: string) => {
  const admission = await ownerMessageAdmission({
    lookup: async () => ({ owner_id: owner, do_name: 'owner-demo', state_version: 0, admission_revision: '1', presence_id: '20000000-0000-0000-0000-000000000001', provider: 'telegram', subject: '1001' }),
    scope: scope(), locator: { environment: 'staging', namespace: 'owner-staging', doName: 'owner-demo', doId: 'actual-do' },
    actualDoId: 'actual-do', expectedDoId: (name: string) => name === 'owner-demo' ? 'actual-do' : 'other-do',
    allowedDoNames: ['owner-demo'], provider: 'telegram' as const, subject: '1001', text,
    occurrenceKey: `feed-${health}`, occurredAt: Date.now() - 1, now: Date.now,
  });
  return createOwnerTurnContext(admission, health ? { health: () => readNow() } : {});
};
const inOwner = <T,>(name: string, work: () => Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), work);
const lastTold = () => {
  const body = seen.bodies.at(-1);
  const input = body?.input;
  const message = typeof input === 'string' ? input : String([...(input ?? [])].reverse().find(entry => entry.role === 'user')?.content ?? '');
  return `${body?.instructions ?? ''}\n\n${message}`;
};
const ASK = 'plan tomorrow around my energy';
const CANARIES = ['a1b2c3d4e5f60718', 'b1b2c3d4e5f60718', 'c1b2c3d4e5f60718'] as const;

describe('an owner turn asking to plan tomorrow around their energy', () => {
  it('composes the health lines into the prompt and lets no number through but the window times', async () => {
    const context = await appContext(true, ASK);
    const composed = await context.composer.compose(context.invocation, { ...context.snapshot(), canary_tokens: [...CANARIES], replay_context_ref: null });
    expect(composed.ok, composed.ok ? undefined : composed.failure.code).toBe(true);
    if (!composed.ok) return;
    const block = healthBlock(composed.prompt);
    expect(block).toContain('Form zone: flagging.');
    expect(block).toContain('Recovery: solid. Load: heavy.');
    expect(block).toContain('Baseline: Recovery and Form provisional');
    expect(block).toContain('Sleep debt: building up over recent nights.');
    expect(block).toContain(WINDOW_LINE);
    expect(composed.prompt).not.toContain('Active goals');
    for (const seeded of SEEDED) expect(composed.prompt).not.toContain(seeded);
    expect(composed.healthPrompt).toBe(block);
    expect(block.replace(clockTimes, '')).not.toMatch(/\d/);
  });

  it('tells the model the same on the messaging path, once, with no seeded number', async () => {
    await inOwner('health-feed-with', async () => {
      const responder = createOwnerResponder('fixture', undefined, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => readNow());
      await responder.respond(ownerTyped({ traceId: 'tg-feed-1', conversationRef: 'owner', surface: 'telegram', text: ASK }), (_name, work) => work());
    });
    const told = lastTold();
    expect(told.split(WINDOW_LINE).length - 1).toBe(1);
    expect(told).toContain('Sleep debt: building up over recent nights.');
    expect(told).not.toContain(ABSENT);
    for (const seeded of SEEDED) expect(told).not.toContain(seeded);
    expect(healthBlock(told).replace(clockTimes, '')).not.toMatch(/\d/);
  });

  it('says there is none and carries no health line when the owner shares no health', async () => {
    await inOwner('health-feed-without', async () => {
      const responder = createOwnerResponder('fixture', undefined, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => null);
      await responder.respond(ownerTyped({ traceId: 'tg-feed-2', conversationRef: 'owner', surface: 'telegram', text: ASK }), (_name, work) => work());
    });
    const told = lastTold();
    expect(told.split(ABSENT).length - 1).toBe(1);
    for (const line of ['Form zone:', 'Recovery zone:', 'Baseline:', 'Sleep debt', 'Energy windows', 'Active goals']) expect(told).not.toContain(line);
    const context = await appContext(false, ASK);
    const composed = await context.composer.compose(context.invocation, { ...context.snapshot(), canary_tokens: [...CANARIES], replay_context_ref: null });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.prompt).toContain(ABSENT);
    for (const line of ['Form zone:', 'Baseline:', 'Sleep debt', 'Energy windows', 'Active goals']) expect(composed.prompt).not.toContain(line);
  });
});
