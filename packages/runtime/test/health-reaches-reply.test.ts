import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { toContextHealthMaterial, type HealthContextRow } from '../src/channels/health-context';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { ownerMessageAdmission } from '../src/identity/owner-message-admission';

const seen = vi.hoisted(() => ({ bodies: [] as Array<{ instructions?: string }> }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: { instructions?: string }) => {
  seen.bodies.push(body);
  return { id: 'fixture', output_text: 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
beforeEach(() => { seen.bodies = []; });

const clock = { timezone: 'UTC', now: () => new Date() };
const today = new Date().toISOString().slice(0, 10);
const row: HealthContextRow = {
  context: {
    id: 'ctx-1', day: today,
    form: { score: 72, zone: 'good', drivers: ['sleep below baseline'], confidence: 0.8 },
    recovery: { score: 70, zone: 'good' }, weight: { score: 45, zone: 'moderate' },
    drivers: ['sleep below baseline'], confidence: 0.8, freshness: 'fresh', tags: ['travel'], compiled_at: new Date(Date.now() - 3_600_000).toISOString(),
  },
  previous: null,
};
// Read during composition, after the turn's snapshot, as the owner DO reads it.
const readNow = async () => {
  await new Promise(resolve => setTimeout(resolve, 5));
  const built = toContextHealthMaterial(row, clock);
  expect(built).not.toBeNull();
  return built;
};

const ABSENT = 'No derived health context is available';
const count = (text: string, needle: string) => text.split(needle).length - 1;
// The owner's shared health context is the input for every health promise (Recovery, Form, Load,
// health-aware Briefs). The reply model must be told it exactly once, and told plainly when it is absent.
const expectHealth = (instructions: string) => {
  expect(count(instructions, 'Form zone: steady.')).toBe(1);
  expect(count(instructions, 'Recovery: solid. Load: moderate.')).toBe(1);
  expect(instructions).not.toContain(ABSENT);
  // The health source never reads the calendar, so it must not claim the day has no high-stakes events.
  expect(instructions).not.toContain('Upcoming high-stakes');
};
const expectAbsent = (instructions: string) => {
  expect(count(instructions, ABSENT)).toBe(1);
  expect(instructions).not.toContain('Form zone:');
};

const responderWith = (health: boolean, log?: (entry: TurnLogEntry) => void) =>
  createOwnerResponder('fixture', undefined, undefined, log, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => health ? readNow() : null);
const inOwner = <T,>(name: string, work: () => Promise<T>) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), work);
const lastInstructions = () => seen.bodies.at(-1)?.instructions ?? '';

it('a messaging owner turn tells the model the shared health context, in its own measured section', async () => {
  const logs: TurnLogEntry[] = [];
  await inOwner('health-reply-with', async () => {
    await responderWith(true, entry => logs.push(entry)).respond({ traceId: 'tg-health-1', conversationRef: 'owner', surface: 'telegram', text: 'how am I doing today?' }, (_name, work) => work());
  });
  expectHealth(lastInstructions());
  const shape = logs.find(entry => entry.hop === 'llm_reply')!.shape!;
  const { skill_procedures: procedures = 0, ...joined } = shape.context!.system_sections!;
  expect(joined.health).toBeGreaterThan(0);
  const pieces = Object.values(joined);
  expect(pieces.reduce((sum, bytes) => sum + bytes, 0) + 2 * (pieces.length - 1) + procedures).toBe(shape.system_bytes);
});

it('a messaging owner turn without shared health says so once', async () => {
  await inOwner('health-reply-without', async () => {
    await responderWith(false).respond({ traceId: 'tg-health-2', conversationRef: 'owner', surface: 'telegram', text: 'how am I doing today?' }, (_name, work) => work());
  });
  expectAbsent(lastInstructions());
});

it('a scheduled prompt such as the Brief tells the model the shared health context', async () => {
  await inOwner('health-brief-with', async () => {
    await expect(responderWith(true).prompt('card:brief:1', 'owner', 'Write the morning brief.', async (_hop, work) => work())).resolves.toBeTypeOf('string');
  });
  expectHealth(lastInstructions());
});

const owner = '10000000-0000-0000-0000-000000000001';
const scope = (): RunEffectScope => ({ runId: 'run-one', attempt: 'attempt-one', deadline: Date.now() + 30_000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() });
const appContext = async (health: boolean, text: string) => {
  const admission = await ownerMessageAdmission({
    lookup: async () => ({ owner_id: owner, do_name: 'owner-demo', state_version: 0, admission_revision: '1', presence_id: '20000000-0000-0000-0000-000000000001', provider: 'telegram', subject: '1001' }),
    scope: scope(), locator: { environment: 'staging', namespace: 'owner-staging', doName: 'owner-demo', doId: 'actual-do' },
    actualDoId: 'actual-do', expectedDoId: (name: string) => name === 'owner-demo' ? 'actual-do' : 'other-do',
    allowedDoNames: ['owner-demo'], provider: 'telegram' as const, subject: '1001', text,
    occurrenceKey: `app-${health}`, occurredAt: Date.now() - 1, now: Date.now,
  });
  return createOwnerTurnContext(admission, health ? { health: readNow } : {});
};

it('an app owner turn tells the model the shared health context once, with no absence line', async () => {
  const text = 'how am I doing today?';
  const context = await appContext(true, text);
  const runScope = scope();
  await inOwner('health-app-with', async () => {
    const responder = createOwnerResponder('fixture', undefined, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [], runScope, undefined, { context });
    await responder.respond({ traceId: 'app-health-1', conversationRef: context.conversationRef, surface: 'app', text }, (_name, work) => work());
  });
  expectHealth(lastInstructions());
});

it('the app context composer states absence when the owner has no shared health', async () => {
  const context = await appContext(false, 'hello');
  const composed = await context.composer.compose(context.invocation, { ...context.snapshot(), canary_tokens: ['a1b2c3d4e5f60718', 'b1b2c3d4e5f60718', 'c1b2c3d4e5f60718'], replay_context_ref: null });
  expect(composed.ok).toBe(true);
  if (composed.ok) expectAbsent(composed.prompt);
});
