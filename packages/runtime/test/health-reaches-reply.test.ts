import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { toContextHealthMaterial, type HealthContextRow } from '../src/channels/health-context';

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

// The owner's shared health context is the input for every health promise. A turn that has it
// must still complete: the composer fails closed on any source it cannot attest. The material is
// read during composition, as the owner DO reads it, so the read happens after the turn's snapshot.
const readNow = async () => {
  await new Promise(resolve => setTimeout(resolve, 5));
  const material = toContextHealthMaterial(row, clock);
  expect(material).not.toBeNull();
  return material;
};
const reply = async (name: string, withHealth: boolean) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async () => {
    seen.bodies = [];
    const health = async () => withHealth ? readNow() : null;
    const responder = createOwnerResponder('fixture', undefined, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, health);
    return responder.respond({ traceId: 'tg-health-1', conversationRef: 'owner', surface: 'telegram', text: 'how am I doing today?' }, (_name, work) => work());
  });

it('an owner turn completes when shared health context is present', async () => {
  await expect(reply('health-turn-completes', true)).resolves.toBeTruthy();
  expect(seen.bodies.length).toBeGreaterThan(0);
});

it('a scheduled prompt such as the Brief completes when shared health context is present', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('health-brief-completes')), async () => {
    const responder = createOwnerResponder('fixture', undefined, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, readNow);
    await expect(responder.prompt('card:brief:1', 'owner', 'Write the morning brief.', async (_hop, work) => work())).resolves.toBeTypeOf('string');
  });
});
