import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { renderBlock, renderSkill, type Skill } from '@waldo/contracts';
import { provisionDoSchema } from '../src/do-schema';
import { BUNDLED_SKILL_MAX_BYTES } from '../src/skills/bundled-file';
import { CURATED_SKILLS, CuratedOwnerSkills } from '../src/skills/curated-owner';

// A turn may load more than one reviewed skill while their instructions together fit the turn's skill budget; the budget,
// not a count, is the bound.
const canaries = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const owner = 'owner-a';
const turn = (turnId: string) => ({ owner, turnId, trigger: 'user_message' as const, ownerText: 'plan my week', assertCurrent: async () => {} });
const base = CURATED_SKILLS.find((skill) => skill.trigger_types.includes('user_message'))!;
// Reviewed-shaped skills of a chosen size, so the budget edge is exact whatever the shipped catalog holds.
const sized = (name: string, bytes: number): Skill => ({ ...base, name, body_markdown: `${name}: ${'x'.repeat(bytes)}` });
const blockBytes = (skills: readonly Skill[]) => new TextEncoder().encode(renderBlock(skills.map(renderSkill))).length;
const withBook = (name: string, catalog: readonly Skill[], work: (book: CuratedOwnerSkills) => Promise<void>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(name)), async (_instance, state) => {
    provisionDoSchema(state.storage);
    await work(new CuratedOwnerSkills(state.storage.sql, owner, undefined, owner, catalog));
  });

it('two skills that fit together both load in one turn, and both join its instructions', async () => {
  const a = sized('plan-a', 1_000), b = sized('plan-b', 1_000);
  expect(blockBytes([a, b])).toBeLessThanOrEqual(BUNDLED_SKILL_MAX_BYTES);
  await withBook('skills-two', [a, b], async (book) => {
    expect(book.load(a.name, a.version, turn('t1')).ok).toBe(true);
    expect(book.load(b.name, b.version, turn('t1')).ok).toBe(true);
    const prompt = await book.prompt(turn('t1'), canaries);
    expect(prompt).toContain(a.body_markdown);
    expect(prompt).toContain(b.body_markdown);
    // Loading one already loaded changes nothing.
    expect(book.load(a.name, a.version, turn('t1')).ok).toBe(true);
    expect(await book.prompt(turn('t1'), canaries)).toBe(prompt);
  });
});

it('a skill that would take the turn past its skill budget is refused, and the ones already loaded stay', async () => {
  const a = sized('plan-a', 5_000), b = sized('plan-b', 5_000);
  expect(blockBytes([a])).toBeLessThanOrEqual(BUNDLED_SKILL_MAX_BYTES);
  expect(blockBytes([a, b])).toBeGreaterThan(BUNDLED_SKILL_MAX_BYTES);
  await withBook('skills-over', [a, b], async (book) => {
    expect(book.load(a.name, a.version, turn('t1')).ok).toBe(true);
    const refused = book.load(b.name, b.version, turn('t1'));
    expect(refused.ok).toBe(false);
    const prompt = await book.prompt(turn('t1'), canaries);
    expect(prompt).toContain(a.body_markdown);
    expect(prompt).not.toContain(b.body_markdown);
    // Another turn starts with nothing loaded.
    expect(book.load(b.name, b.version, turn('t2')).ok).toBe(true);
  });
});

it('turning a skill off takes it out of later loads; a turn already running with it fails closed', async () => {
  const a = sized('plan-a', 500), b = sized('plan-b', 500);
  await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName('skills-disable')), async (_instance, state) => {
    provisionDoSchema(state.storage);
    // Each turn builds its own book over the owner's one store, as the host does.
    const book = () => new CuratedOwnerSkills(state.storage.sql, owner, undefined, owner, [a, b]);
    const running = book();
    running.load(a.name, a.version, turn('t1'));
    running.load(b.name, b.version, turn('t1'));
    expect(book().disable(a.name, a.version, { ...turn('t2'), ownerText: `/skills disable ${a.name}` }).ok).toBe(true);
    expect(await running.prompt(turn('t1'), canaries)).toBe('');
    const next = book();
    expect(next.load(a.name, a.version, turn('t3')).ok).toBe(false);
    expect(next.load(b.name, b.version, turn('t3')).ok).toBe(true);
    expect(await next.prompt(turn('t3'), canaries)).toContain(b.body_markdown);
  });
});
