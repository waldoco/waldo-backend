import { z } from 'zod';
import type { RecallGateway } from '../memory/recall';
import type { Skill, SkillLoader } from './skill';

// The 7-layer REASONS Canvas contract (ADR-0028): layer vocabulary and order, per-layer
// input composition, the builder seam, and the deterministic A-layer skill fence. The layer
// renderers themselves are runtime-wave implementation behind this interface.

// Enum order IS canvas order, and safeguards is always last so no later layer can dilute
// the safety rules (ADR-0028).
export const reasonsLayerSchema = z.enum([
  'requirements',
  'entities',
  'approach',
  'structure',
  'operations',
  'norms',
  'safeguards',
]);
export type ReasonsLayer = z.infer<typeof reasonsLayerSchema>;

// The separator is contract: trace assertions and prompt-cache prefixes depend on
// byte-stable canvas assembly (ADR-0028).
export const REASONS_LAYER_JOIN = '\n\n';

// The closed vocabulary of canvas inputs (ADR-0028 buildPrompt composition). Model selection
// is deliberately absent — the roster owns it; a prompt contract never names a model.
export const layerInputSchema = z.enum([
  'trigger_context',
  'user_profile',
  'trigger_behaviour',
  'available_skills',
  'tool_acl',
  'recall',
  'health_context',
  'workspace_files',
  'zone_modifier',
  'mode_template',
  'soul_base',
  'safety_rules',
]);
export type LayerInput = z.infer<typeof layerInputSchema>;

// Per-layer inclusion rules, verbatim from the ADR-0028 composition: each input feeds
// exactly one layer. 'recall' leads operations — memory is consulted before fresh context
// assembles (recall-before-act); 'health_context' is the derived-only NarrativeContext block
// from ./narrative. Operations is the volatile mid-canvas layer (recall + fresh health +
// workspace change per invocation); cache-breakpoint placement around it is an open seam,
// deliberately not pinned here.
export const REASONS_LAYER_INPUTS: Readonly<Record<ReasonsLayer, readonly LayerInput[]>> = {
  requirements: ['trigger_context'],
  entities: ['user_profile'],
  approach: ['trigger_behaviour', 'available_skills'],
  structure: ['tool_acl'],
  operations: ['recall', 'health_context', 'workspace_files'],
  norms: ['zone_modifier', 'mode_template', 'soul_base'],
  safeguards: ['safety_rules'],
};

// The single external seam of the deep builder module (ADR-0028): one call, one canvas
// string. Ctx is the InvocationContext contract owned by a later runtime wave; genericity
// keeps this a static type rather than a Zod schema, like RecallGateway.
export type PromptBuilder<Ctx> = (ctx: Ctx) => Promise<string>;

// The builder's contracted upstream seams: skills from the ADR-0028 loader, memory from the
// single ADR-0031 gateway — recall(ctx, hint?), hint derived from the top-ranked skill,
// invoked deterministically by the builder (never a tool the model must remember to call).
// The three-source recallBeforeAct(ctx, skills) block in ADR-0028 is dead per its ratified
// resolution: a call-site convenience in the ADR's prose, never an export.
export type PromptBuilderDeps<Ctx> = {
  loadForTrigger: SkillLoader<Ctx>['loadForTrigger'];
  recall: RecallGateway<Ctx>;
};

// The A-layer fence, verbatim ADR-0028: deterministic top-K FULL bodies — deliberately not
// name-first progressive disclosure. Zero selected skills render as the empty string, so an
// empty fence never reaches the model.
// Token counts bind to these exact bytes. Increment this revision with any rendered-byte
// change so an older counter capability cannot be reused for a new serializer.
export const SKILL_PROMPT_SERIALIZER_REVISION = 'reasons-skill-fence-v1' as const;

declare const skillPromptFragmentBrand: unique symbol;

export type SkillPromptFragment = string & {
  readonly [skillPromptFragmentBrand]: 'SkillPromptFragment';
};

declare const skillPromptBlockBrand: unique symbol;

export type SkillPromptBlock = string & {
  readonly [skillPromptBlockBrand]: 'SkillPromptBlock';
};

export function renderSkill(skill: Skill): SkillPromptFragment {
  return `<skill name="${skill.name}" effectiveness="${skill.effectiveness.toFixed(2)}" provenance="${skill.provenance}">\n${skill.body_markdown}\n</skill>` as SkillPromptFragment;
}

export function renderBlock(fragments: readonly SkillPromptFragment[]): SkillPromptBlock {
  if (fragments.length === 0) return '' as SkillPromptBlock;
  return `<available-skills>\n${fragments.join('\n\n')}\n</available-skills>` as SkillPromptBlock;
}

export function wrapSkills(skills: readonly Skill[]): string {
  return renderBlock(skills.map(renderSkill));
}
