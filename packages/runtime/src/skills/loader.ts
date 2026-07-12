import type {
  CanaryTokens,
  Skill,
  SkillExclusion,
  SkillFilterResult,
  SkillLoader,
  SkillName,
  TriggerType,
} from '@waldo/contracts';
import {
  DEFAULT_SKILL_TOP_K,
  PROVISIONAL_EFFECTIVENESS_FLOOR,
  SKILL_TOP_K,
  SKILL_TOKEN_BUDGET,
  TOOL_PERMISSIONS,
  renderBlock,
  renderSkill,
  skillSchema,
} from '@waldo/contracts';
import type { ResolvedSkillBudget } from './budget';
import type { MutableSkillReader } from './mutable-reader';

export type RuntimeSkillLoadContext = Readonly<{
  trigger: TriggerType;
  canaryTokens: CanaryTokens;
  connectedConnectors: ReadonlySet<string>;
  dismissedToday: ReadonlySet<SkillName>;
  provisionalReverted: ReadonlySet<SkillName>;
  identityDrift: ReadonlySet<SkillName>;
  priorityPinned: ReadonlySet<SkillName>;
  skillBudget: ResolvedSkillBudget;
}>;

export type RuntimeSkillLoaderDeps = Readonly<{
  systemSkills: readonly Skill[];
  connectorSkills: readonly Skill[];
  mutableReader: Pick<MutableSkillReader, 'load'>;
}>;

type SkillSource = 'system' | 'connector' | 'mutable';

type Candidate = Readonly<{
  skill: Skill;
  source: SkillSource;
}>;

type CandidateSelection = Readonly<{
  selected: readonly Candidate[];
  excluded: readonly SkillExclusion[];
}>;

type SelectionProof =
  | Readonly<{ kind: 'admit' }>
  | Readonly<{ kind: 'global_failure' }>
  | Readonly<{ kind: 'drop_mutable_source' }>;

export class RuntimeSkillLoader implements SkillLoader<RuntimeSkillLoadContext> {
  constructor(private readonly deps: RuntimeSkillLoaderDeps) {}

  async loadForTrigger(ctx: RuntimeSkillLoadContext): Promise<SkillFilterResult> {
    const mutableSkills = await this.readMutable(ctx.canaryTokens);
    const staticCandidates = [
      ...tagSkills(this.deps.systemSkills, 'system'),
      ...tagSkills(this.deps.connectorSkills, 'connector'),
    ];
    const selection = selectCandidates([...staticCandidates, ...tagSkills(mutableSkills, 'mutable')], ctx);
    const proof = await proveSelection(selection.selected, ctx);
    if (proof.kind === 'global_failure') return noFence(selection);
    if (proof.kind === 'admit') return resultFromSelection(selection);

    const staticSelection = selectCandidates(staticCandidates, ctx);
    const staticProof = await proveSelection(staticSelection.selected, ctx);
    return staticProof.kind === 'admit' ? resultFromSelection(staticSelection) : noFence(staticSelection);
  }

  private async readMutable(canaryTokens: CanaryTokens): Promise<readonly Skill[]> {
    try {
      const result: unknown = await this.deps.mutableReader.load(canaryTokens);
      if (typeof result !== 'object' || result === null) return [];
      const candidate = result as { ok?: unknown; skills?: unknown };
      if (candidate.ok !== true || !Array.isArray(candidate.skills)) return [];
      const skills: Skill[] = [];
      for (const value of candidate.skills) {
        const parsed = skillSchema.safeParse(value);
        if (
          !parsed.success ||
          (parsed.data.provenance !== 'user' && parsed.data.provenance !== 'agent_authored')
        ) {
          return [];
        }
        skills.push(parsed.data);
      }
      return skills;
    } catch {
      // Mutable-source failure is deliberately source-local.
      return [];
    }
  }
}

function resultFromSelection(selection: CandidateSelection): SkillFilterResult {
  return {
    selected: selection.selected.map(({ skill }) => skill),
    excluded: [...selection.excluded],
  };
}

function noFence(selection: CandidateSelection): SkillFilterResult {
  return { selected: [], excluded: [...selection.excluded] };
}

function tagSkills(skills: readonly Skill[], source: SkillSource): readonly Candidate[] {
  return skills.map((skill) => ({ skill, source }));
}

function selectCandidates(
  candidates: readonly Candidate[],
  ctx: RuntimeSkillLoadContext,
): CandidateSelection {
  const eligible: Candidate[] = [];
  const excluded: SkillExclusion[] = [];
  for (const candidate of candidates) {
    const reason = exclusionReason(candidate.skill, ctx);
    if (reason === null) {
      eligible.push(candidate);
    } else {
      excluded.push({ skill_name: candidate.skill.name, reason });
    }
  }

  eligible.sort((left, right) => compareCandidates(left, right, ctx));
  return { selected: eligible.slice(0, topKFor(ctx.trigger)), excluded };
}

function compareCandidates(
  left: Candidate,
  right: Candidate,
  ctx: RuntimeSkillLoadContext,
): number {
  const leftPinned = ctx.priorityPinned.has(left.skill.name);
  const rightPinned = ctx.priorityPinned.has(right.skill.name);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  if (left.skill.effectiveness !== right.skill.effectiveness) {
    return right.skill.effectiveness - left.skill.effectiveness;
  }

  const leftLastUsed = parsedLastUsed(left.skill);
  const rightLastUsed = parsedLastUsed(right.skill);
  if (leftLastUsed !== rightLastUsed) return rightLastUsed > leftLastUsed ? 1 : -1;
  if (left.skill.name < right.skill.name) return -1;
  if (left.skill.name > right.skill.name) return 1;
  return 0;
}

function parsedLastUsed(skill: Skill): number {
  if (skill.last_used === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(skill.last_used);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

async function proveSelection(
  selected: readonly Candidate[],
  ctx: RuntimeSkillLoadContext,
): Promise<SelectionProof> {
  if (selected.length === 0) return { kind: 'admit' };

  const fragments = selected.map(({ skill }) => renderSkill(skill));
  let globalFailure = false;
  let mutableFragmentOverBudget = false;
  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    const fragment = fragments[index];
    if (candidate === undefined || fragment === undefined) return { kind: 'global_failure' };
    const tokens = await countSkill(ctx.skillBudget, fragment);
    if (tokens === null) {
      globalFailure = true;
    } else if (tokens > SKILL_TOKEN_BUDGET.body_max) {
      if (candidate.source === 'mutable') {
        mutableFragmentOverBudget = true;
      } else {
        globalFailure = true;
      }
    }
  }

  if (globalFailure) return { kind: 'global_failure' };
  if (mutableFragmentOverBudget) return { kind: 'drop_mutable_source' };

  const blockTokens = await countBlock(ctx.skillBudget, renderBlock(fragments));
  if (blockTokens === null || blockTokens > SKILL_TOKEN_BUDGET.body_max * topKFor(ctx.trigger)) {
    return { kind: 'global_failure' };
  }
  return { kind: 'admit' };
}

function topKFor(trigger: TriggerType): number {
  return SKILL_TOP_K[trigger] ?? DEFAULT_SKILL_TOP_K;
}

async function countSkill(
  budget: ResolvedSkillBudget,
  fragment: Parameters<ResolvedSkillBudget['countRenderedSkill']>[0],
): Promise<number | null> {
  try {
    return countedTokens(await budget.countRenderedSkill(fragment));
  } catch {
    return null;
  }
}

async function countBlock(
  budget: ResolvedSkillBudget,
  block: Parameters<ResolvedSkillBudget['countRenderedBlock']>[0],
): Promise<number | null> {
  try {
    return countedTokens(await budget.countRenderedBlock(block));
  } catch {
    return null;
  }
}

function countedTokens(value: unknown): number | null {
  if (value === null || typeof value !== 'object') return null;
  const result = value as { ok?: unknown; tokens?: unknown };
  return result.ok === true &&
    typeof result.tokens === 'number' &&
    Number.isSafeInteger(result.tokens) &&
    result.tokens >= 0
    ? result.tokens
    : null;
}

function exclusionReason(
  skill: Skill,
  ctx: RuntimeSkillLoadContext,
): SkillExclusion['reason'] | null {
  if (!skill.trigger_types.includes(ctx.trigger)) return 'trigger_mismatch';
  const permittedTools = TOOL_PERMISSIONS[ctx.trigger];
  if (!skill.required_tools.every((tool) => (permittedTools as readonly string[]).includes(tool))) {
    return 'acl_violation';
  }
  if (!skill.required_connectors.every((connector) => ctx.connectedConnectors.has(connector))) {
    return 'missing_connector';
  }
  if (ctx.dismissedToday.has(skill.name)) return 'dismissed_today';
  if (skill.provisional && skill.effectiveness < PROVISIONAL_EFFECTIVENESS_FLOOR) {
    return 'effectiveness_below_floor';
  }
  if (ctx.provisionalReverted.has(skill.name)) return 'provisional_revert';
  if (ctx.identityDrift.has(skill.name)) return 'identity_drift_detected';
  return null;
}
