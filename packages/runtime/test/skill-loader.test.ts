import {
  renderBlock,
  renderSkill,
  skillSchema,
  wrapSkills,
  type CanaryTokens,
  type Skill,
  type SkillName,
  type SkillPromptBlock,
  type SkillPromptFragment,
  type TriggerType,
} from '@waldo/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSkillBudget } from '../src/skills/budget';
import { RuntimeSkillLoader, type RuntimeSkillLoadContext } from '../src/skills/loader';
import type { MutableSkillReader } from '../src/skills/mutable-reader';

const CANARIES: CanaryTokens = [
  '1111111111111111',
  '2222222222222222',
  '3333333333333333',
];

type SkillFixture = Omit<Partial<Skill>, 'last_used' | 'created_at'> &
  Readonly<{ last_used?: string | null; created_at?: string }>;

function makeSkill(name: string, overrides: SkillFixture = {}): Skill {
  return skillSchema.parse({
    name,
    version: 1,
    provenance: 'system',
    identity_locked: true,
    provisional: false,
    trigger_types: ['brief'],
    trigger_condition: 'Use this skill for the synthetic fixture.',
    required_tools: [],
    required_connectors: [],
    effectiveness: 0.8,
    invocations: 3,
    last_used: '2026-07-12T00:00:00Z',
    body_markdown: `${name} synthetic body`,
    created_at: '2026-07-01T00:00:00Z',
    ...overrides,
  });
}

function fixtureBudget(): Readonly<{
  skillBudget: ResolvedSkillBudget;
  countRenderedSkill: ReturnType<typeof vi.fn>;
  countRenderedBlock: ReturnType<typeof vi.fn>;
}> {
  const countRenderedSkill = vi.fn(async () => ({ ok: true as const, tokens: 1 }));
  const countRenderedBlock = vi.fn(async () => ({ ok: true as const, tokens: 1 }));
  return {
    skillBudget: { countRenderedSkill, countRenderedBlock },
    countRenderedSkill,
    countRenderedBlock,
  };
}

function fixtureContext(
  skillBudget: ResolvedSkillBudget,
  overrides: Partial<Omit<RuntimeSkillLoadContext, 'skillBudget'>> = {},
): RuntimeSkillLoadContext {
  return {
    trigger: 'brief',
    canaryTokens: CANARIES,
    connectedConnectors: new Set(),
    dismissedToday: new Set<SkillName>(),
    provisionalReverted: new Set<SkillName>(),
    identityDrift: new Set<SkillName>(),
    priorityPinned: new Set<SkillName>(),
    ...overrides,
    skillBudget,
  };
}

function readerWith(skills: readonly Skill[] = []) {
  return {
    load: vi.fn(async () => ({ ok: true as const, skills })),
  };
}

describe('RuntimeSkillLoader', () => {
  it('returns an empty result without consulting a counter when every source is empty', async () => {
    const countRenderedSkill = vi.fn();
    const countRenderedBlock = vi.fn();
    const mutableReader = {
      load: vi.fn(async () => ({ ok: true as const, skills: [] })),
    };
    const loader = new RuntimeSkillLoader({
      systemSkills: [],
      connectorSkills: [],
      mutableReader,
    });
    const skillBudget: ResolvedSkillBudget = {
      countRenderedSkill,
      countRenderedBlock,
    };

    const result = await loader.loadForTrigger({
      trigger: 'brief',
      canaryTokens: CANARIES,
      connectedConnectors: new Set(),
      dismissedToday: new Set(),
      provisionalReverted: new Set(),
      identityDrift: new Set(),
      priorityPinned: new Set(),
      skillBudget,
    });

    expect(result).toEqual({ selected: [], excluded: [] });
    expect(mutableReader.load).toHaveBeenCalledOnce();
    expect(mutableReader.load).toHaveBeenCalledWith(CANARIES);
    expect(countRenderedSkill).not.toHaveBeenCalled();
    expect(countRenderedBlock).not.toHaveBeenCalled();
  });

  it('records only the first failed eligibility stage using the closed exclusion vocabulary', async () => {
    const triggerMismatch = makeSkill('trigger-mismatch', {
      trigger_types: ['patrol'],
      required_tools: ['execute_code'],
      required_connectors: ['missing-connector'],
      provisional: true,
      effectiveness: 0.1,
    });
    const aclViolation = makeSkill('acl-violation', {
      required_tools: ['execute_code'],
      required_connectors: ['missing-connector'],
      provisional: true,
      effectiveness: 0.1,
    });
    const missingConnector = makeSkill('missing-connector', {
      required_connectors: ['missing-connector'],
      provisional: true,
      effectiveness: 0.1,
    });
    const dismissed = makeSkill('dismissed', { provisional: true, effectiveness: 0.1 });
    const belowFloor = makeSkill('below-floor', { provisional: true, effectiveness: 0.39 });
    const reverted = makeSkill('reverted', { provisional: true, effectiveness: 0.9 });
    const drifted = makeSkill('drifted');
    const mutableReader = readerWith();
    const { skillBudget, countRenderedSkill, countRenderedBlock } = fixtureBudget();
    const loader = new RuntimeSkillLoader({
      systemSkills: [
        triggerMismatch,
        aclViolation,
        missingConnector,
        dismissed,
        belowFloor,
        reverted,
        drifted,
      ],
      connectorSkills: [],
      mutableReader,
    });

    const result = await loader.loadForTrigger(
      fixtureContext(skillBudget, {
        dismissedToday: new Set([dismissed.name]),
        provisionalReverted: new Set([reverted.name, belowFloor.name]),
        identityDrift: new Set([drifted.name, reverted.name, belowFloor.name]),
      }),
    );

    expect(result).toEqual({
      selected: [],
      excluded: [
        { skill_name: triggerMismatch.name, reason: 'trigger_mismatch' },
        { skill_name: aclViolation.name, reason: 'acl_violation' },
        { skill_name: missingConnector.name, reason: 'missing_connector' },
        { skill_name: dismissed.name, reason: 'dismissed_today' },
        { skill_name: belowFloor.name, reason: 'effectiveness_below_floor' },
        { skill_name: reverted.name, reason: 'provisional_revert' },
        { skill_name: drifted.name, reason: 'identity_drift_detected' },
      ],
    });
    expect(mutableReader.load).toHaveBeenCalledWith(CANARIES);
    expect(countRenderedSkill).not.toHaveBeenCalled();
    expect(countRenderedBlock).not.toHaveBeenCalled();
  });

  it('ranks all sources by explicit priority pin, effectiveness, parsed use time, and ASCII name', async () => {
    const legacyPinned = Object.assign(
      {},
      makeSkill('legacy-pinned', {
        trigger_types: ['user_message'],
        effectiveness: 0.1,
        last_used: '2026-07-12T00:00:00Z',
      }),
      { pinned: true },
    ) as Skill;
    const explicitPriority = makeSkill('priority-pinned', {
      trigger_types: ['user_message'],
      effectiveness: 0.1,
      last_used: null,
    });
    const alpha = makeSkill('alpha', {
      provenance: 'user',
      trigger_types: ['user_message'],
      effectiveness: 0.9,
      last_used: '2026-07-03T00:00:00Z',
    });
    const bravo = makeSkill('bravo', {
      provenance: 'user',
      trigger_types: ['user_message'],
      effectiveness: 0.9,
      last_used: '2026-07-03T00:00:00Z',
    });
    const recent = makeSkill('recent', {
      provenance: 'user',
      trigger_types: ['user_message'],
      effectiveness: 0.8,
      last_used: '2026-07-04T00:00:00Z',
    });
    const older = makeSkill('older', {
      trigger_types: ['user_message'],
      effectiveness: 0.8,
      last_used: '2026-07-02T00:00:00Z',
    });
    const nullLast = makeSkill('null-last', {
      trigger_types: ['user_message'],
      effectiveness: 0.8,
      last_used: null,
    });
    const mutableReader = readerWith([alpha, bravo, recent]);
    const { skillBudget } = fixtureBudget();
    const loader = new RuntimeSkillLoader({
      systemSkills: [legacyPinned, older],
      connectorSkills: [explicitPriority, nullLast],
      mutableReader,
    });

    const result = await loader.loadForTrigger(
      fixtureContext(skillBudget, {
        trigger: 'user_message',
        priorityPinned: new Set([explicitPriority.name]),
      }),
    );

    expect(result.selected.map((skill) => skill.name)).toEqual([
      explicitPriority.name,
      alpha.name,
      bravo.name,
      recent.name,
      older.name,
      nullLast.name,
      legacyPinned.name,
    ]);
    expect(result.excluded).toEqual([]);
  });

  it('uses the default top-K when a trigger has no published override', async () => {
    const skills = [
      makeSkill('default-one', { trigger_types: ['pre_brief_sweep'], effectiveness: 0.9 }),
      makeSkill('default-two', { trigger_types: ['pre_brief_sweep'], effectiveness: 0.8 }),
      makeSkill('default-three', { trigger_types: ['pre_brief_sweep'], effectiveness: 0.7 }),
      makeSkill('default-four', { trigger_types: ['pre_brief_sweep'], effectiveness: 0.6 }),
      makeSkill('default-five', { trigger_types: ['pre_brief_sweep'], effectiveness: 0.5 }),
      makeSkill('default-six', { trigger_types: ['pre_brief_sweep'], effectiveness: 0.4 }),
    ];
    const { skillBudget } = fixtureBudget();
    const loader = new RuntimeSkillLoader({
      systemSkills: skills,
      connectorSkills: [],
      mutableReader: readerWith(),
    });

    const result = await loader.loadForTrigger(
      fixtureContext(skillBudget, { trigger: 'pre_brief_sweep' }),
    );

    expect(result.selected.map((skill) => skill.name)).toEqual(skills.slice(0, 5).map((skill) => skill.name));
  });

  it('limits a nine-skill user_message candidate set to its published K of eight', async () => {
    const skills = Array.from({ length: 9 }, (_, index) =>
      makeSkill(`user-message-${index + 1}`, {
        trigger_types: ['user_message'],
        effectiveness: 1 - index / 100,
      }),
    );
    const { skillBudget } = fixtureBudget();
    const loader = new RuntimeSkillLoader({
      systemSkills: skills,
      connectorSkills: [],
      mutableReader: readerWith(),
    });

    const result = await loader.loadForTrigger(fixtureContext(skillBudget, { trigger: 'user_message' }));

    expect(result.selected).toEqual(skills.slice(0, 8));
  });

  it.each([
    ['throws', async () => Promise.reject(new Error('fake-source-unavailable'))],
    ['reports source failure', async () => ({ ok: false as const, failure: 'source_unavailable' as const })],
    ['returns a malformed result', async () => ({ ok: true, skills: 'not-a-skill-list' })],
  ])('keeps independently loaded static sources when mutable reader %s', async (_case, read) => {
    const system = makeSkill('static-system', { effectiveness: 0.7 });
    const connector = makeSkill('static-connector', { effectiveness: 0.9 });
    const mutableReader = { load: vi.fn(read) };
    const { skillBudget } = fixtureBudget();
    const loader = new RuntimeSkillLoader({
      systemSkills: [system],
      connectorSkills: [connector],
      mutableReader: mutableReader as unknown as Pick<MutableSkillReader, 'load'>,
    });

    const result = await loader.loadForTrigger(fixtureContext(skillBudget));

    expect(result).toEqual({ selected: [connector, system], excluded: [] });
    expect(mutableReader.load).toHaveBeenCalledOnce();
    expect(mutableReader.load).toHaveBeenCalledWith(CANARIES);
  });

  it('treats a non-mutable fake reader payload as a source failure', async () => {
    const staticSkill = makeSkill('static-survives-forged-reader', { effectiveness: 0.7 });
    const forgedStatic = makeSkill('forged-static-from-reader', { effectiveness: 0.9 });
    const mutableReader = {
      load: vi.fn(async () => ({ ok: true as const, skills: [forgedStatic] })),
    };
    const { skillBudget } = fixtureBudget();
    const loader = new RuntimeSkillLoader({
      systemSkills: [staticSkill],
      connectorSkills: [],
      mutableReader: mutableReader as unknown as Pick<MutableSkillReader, 'load'>,
    });

    const result = await loader.loadForTrigger(fixtureContext(skillBudget));

    expect(result).toEqual({ selected: [staticSkill], excluded: [] });
  });

  it('counts the canonical fragment and block artifacts before admitting an exact-600 static skill', async () => {
    const staticSkill = makeSkill('canonical-static');
    const countRenderedSkill = vi.fn(async (fragment: SkillPromptFragment) => {
      expect(fragment).toBe(renderSkill(staticSkill));
      return { ok: true as const, tokens: 600 };
    });
    const countRenderedBlock = vi.fn(async (block) => {
      expect(block).toBe(renderBlock([renderSkill(staticSkill)]));
      return { ok: true as const, tokens: 3_000 };
    });
    const loader = new RuntimeSkillLoader({
      systemSkills: [staticSkill],
      connectorSkills: [],
      mutableReader: readerWith(),
    });
    const skillBudget: ResolvedSkillBudget = { countRenderedSkill, countRenderedBlock };

    const result = await loader.loadForTrigger(fixtureContext(skillBudget));

    expect(result).toEqual({ selected: [staticSkill], excluded: [] });
    expect(countRenderedSkill).toHaveBeenCalledOnce();
    expect(countRenderedBlock).toHaveBeenCalledOnce();
    expect(wrapSkills(result.selected)).toBe(renderBlock([renderSkill(staticSkill)]));
  });

  it('drops a 601-token mutable source as a whole and reselects only static candidates', async () => {
    const staticSkill = makeSkill('static-safe', { effectiveness: 0.8 });
    const staticDismissed = makeSkill('static-dismissed');
    const mutableOversize = makeSkill('mutable-oversize', {
      provenance: 'user',
      effectiveness: 0.7,
    });
    const mutableMismatch = makeSkill('mutable-mismatch', {
      provenance: 'agent_authored',
      trigger_types: ['patrol'],
    });
    const mutableReader = readerWith([mutableOversize, mutableMismatch]);
    const countRenderedSkill = vi.fn(async (fragment: SkillPromptFragment) => ({
      ok: true as const,
      tokens: fragment === renderSkill(mutableOversize) ? 601 : 600,
    }));
    const countRenderedBlock = vi.fn(async () => ({ ok: true as const, tokens: 3_000 }));
    const loader = new RuntimeSkillLoader({
      systemSkills: [staticSkill, staticDismissed],
      connectorSkills: [],
      mutableReader,
    });

    const result = await loader.loadForTrigger(
      fixtureContext(
        { countRenderedSkill, countRenderedBlock },
        { dismissedToday: new Set([staticDismissed.name]) },
      ),
    );

    expect(result).toEqual({
      selected: [staticSkill],
      excluded: [{ skill_name: staticDismissed.name, reason: 'dismissed_today' }],
    });
    expect(mutableReader.load).toHaveBeenCalledOnce();
    expect(countRenderedSkill).toHaveBeenCalledTimes(3);
    expect(countRenderedBlock).toHaveBeenCalledOnce();
  });

  it('gives a later fragment counter failure global precedence over an earlier mutable 601', async () => {
    const staticSkill = makeSkill('static-counter-failure', { effectiveness: 0.1 });
    const mutableOversize = makeSkill('mutable-first', { provenance: 'user', effectiveness: 0.9 });
    const countRenderedSkill = vi.fn(async (fragment: SkillPromptFragment) => {
      if (fragment === renderSkill(mutableOversize)) return { ok: true as const, tokens: 601 };
      return { ok: false as const, code: 'count_failed' as const };
    });
    const countRenderedBlock = vi.fn(async () => ({ ok: true as const, tokens: 1 }));
    const loader = new RuntimeSkillLoader({
      systemSkills: [staticSkill],
      connectorSkills: [],
      mutableReader: readerWith([mutableOversize]),
    });

    const result = await loader.loadForTrigger(
      fixtureContext(
        { countRenderedSkill, countRenderedBlock },
        { priorityPinned: new Set([mutableOversize.name]) },
      ),
    );

    expect(result).toEqual({ selected: [], excluded: [] });
    expect(wrapSkills(result.selected)).toBe('');
    expect(countRenderedSkill.mock.calls.map(([fragment]) => fragment)).toEqual([
      renderSkill(mutableOversize),
      renderSkill(staticSkill),
    ]);
    expect(countRenderedBlock).not.toHaveBeenCalled();
  });

  it('gives a later static 601 global precedence over an earlier mutable 601', async () => {
    const staticOversize = makeSkill('static-after-mutable', { effectiveness: 0.1 });
    const mutableOversize = makeSkill('mutable-before-static', {
      provenance: 'user',
      effectiveness: 0.9,
    });
    const countRenderedSkill = vi.fn(async () => ({ ok: true as const, tokens: 601 }));
    const countRenderedBlock = vi.fn(async () => ({ ok: true as const, tokens: 1 }));
    const loader = new RuntimeSkillLoader({
      systemSkills: [staticOversize],
      connectorSkills: [],
      mutableReader: readerWith([mutableOversize]),
    });

    const result = await loader.loadForTrigger(
      fixtureContext(
        { countRenderedSkill, countRenderedBlock },
        { priorityPinned: new Set([mutableOversize.name]) },
      ),
    );

    expect(result).toEqual({ selected: [], excluded: [] });
    expect(countRenderedSkill).toHaveBeenCalledTimes(2);
    expect(countRenderedBlock).not.toHaveBeenCalled();
  });

  it('fails closed when a selected static fragment exceeds 600 tokens', async () => {
    const staticOversize = makeSkill('static-oversize');
    const countRenderedSkill = vi.fn(async () => ({ ok: true as const, tokens: 601 }));
    const countRenderedBlock = vi.fn(async () => ({ ok: true as const, tokens: 1 }));
    const loader = new RuntimeSkillLoader({
      systemSkills: [staticOversize],
      connectorSkills: [],
      mutableReader: readerWith(),
    });

    const result = await loader.loadForTrigger(
      fixtureContext({ countRenderedSkill, countRenderedBlock }),
    );

    expect(result).toEqual({ selected: [], excluded: [] });
    expect(wrapSkills(result.selected)).toBe('');
    expect(countRenderedBlock).not.toHaveBeenCalled();
  });

  it.each([
    ['unavailable', () => ({ ok: false, code: 'unavailable' })],
    ['unmapped model', () => ({ ok: false, code: 'unmapped_model' })],
    ['unpinned revision', () => ({ ok: false, code: 'unpinned_revision' })],
    ['count failure', () => ({ ok: false, code: 'count_failed' })],
    ['serializer mismatch', () => ({ ok: false, code: 'serializer_mismatch' })],
    ['malformed success', () => ({ ok: true, tokens: 600.5 })],
    ['throw', () => {
      throw new Error('fake-counter-throw');
    }],
  ])('fails closed when a fragment counter reports %s', async (_case, resultForCall) => {
    const staticSkill = makeSkill('counter-failure');
    const countRenderedSkill = vi.fn(async () => resultForCall());
    const countRenderedBlock = vi.fn(async () => ({ ok: true as const, tokens: 1 }));
    const loader = new RuntimeSkillLoader({
      systemSkills: [staticSkill],
      connectorSkills: [],
      mutableReader: readerWith(),
    });

    const result = await loader.loadForTrigger(
      fixtureContext({ countRenderedSkill, countRenderedBlock } as unknown as ResolvedSkillBudget),
    );

    expect(result).toEqual({ selected: [], excluded: [] });
    expect(wrapSkills(result.selected)).toBe('');
    expect(countRenderedBlock).not.toHaveBeenCalled();
  });

  it.each([
    ['unavailable', () => ({ ok: false, code: 'unavailable' })],
    ['malformed result', () => ({ ok: true, tokens: -1 })],
    ['throw', () => {
      throw new Error('fake-block-counter-throw');
    }],
  ])('fails closed when the final canonical block counter reports %s', async (_case, resultForCall) => {
    const staticSkill = makeSkill('block-counter-failure');
    const countRenderedSkill = vi.fn(async () => ({ ok: true as const, tokens: 1 }));
    const countRenderedBlock = vi.fn(async () => resultForCall());
    const loader = new RuntimeSkillLoader({
      systemSkills: [staticSkill],
      connectorSkills: [],
      mutableReader: readerWith(),
    });

    const result = await loader.loadForTrigger(
      fixtureContext({ countRenderedSkill, countRenderedBlock } as unknown as ResolvedSkillBudget),
    );

    expect(result).toEqual({ selected: [], excluded: [] });
    expect(wrapSkills(result.selected)).toBe('');
    expect(countRenderedBlock).toHaveBeenCalledOnce();
  });

  it.each([
    ['default K exact boundary', 'pre_brief_sweep', 5, 3_000, true],
    ['default K aggregate overflow', 'pre_brief_sweep', 5, 3_001, false],
    ['user-message K exact boundary', 'user_message', 8, 4_800, true],
    ['user-message K aggregate overflow', 'user_message', 8, 4_801, false],
  ] as const)(
    'enforces %s against the canonical rendered block',
    async (_case, trigger, count, blockTokens, admitted) => {
      const skills = Array.from({ length: count }, (_, index) =>
        makeSkill(`aggregate-${count}-${index + 1}`, {
          trigger_types: [trigger as TriggerType],
          effectiveness: 1 - index / 100,
        }),
      );
      const expectedBlock = renderBlock(skills.map(renderSkill));
      const countRenderedSkill = vi.fn(async () => ({ ok: true as const, tokens: 600 }));
      const countRenderedBlock = vi.fn(async (block: SkillPromptBlock) => {
        expect(block).toBe(expectedBlock);
        return { ok: true as const, tokens: blockTokens };
      });
      const loader = new RuntimeSkillLoader({
        systemSkills: skills,
        connectorSkills: [],
        mutableReader: readerWith(),
      });

      const result = await loader.loadForTrigger(
        fixtureContext({ countRenderedSkill, countRenderedBlock }, { trigger: trigger as TriggerType }),
      );

      expect(result.selected).toEqual(admitted ? skills : []);
      expect(wrapSkills(result.selected)).toBe(admitted ? expectedBlock : '');
      expect(countRenderedSkill).toHaveBeenCalledTimes(count);
      expect(countRenderedBlock).toHaveBeenCalledOnce();
    },
  );
});
