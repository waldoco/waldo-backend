import {
  REASONS_LAYER_JOIN,
  TOOL_PERMISSIONS,
  narrativeContextSchema,
  renderBlock,
  renderRecall,
  renderSkill,
  type ChannelPersona,
  type ConflictPair,
  type DominanceAuthority,
  type NarrativeContext,
  type PromptBuilder,
  type PromptBuilderDeps,
} from '@waldo/contracts';
import type { RuntimeRecallContext } from '../recall/gateway';
import type { RuntimeSkillLoadContext } from '../skills/loader';

export type RuntimePromptWorkspace = Readonly<{
  kind: 'unavailable';
}>;

export type RuntimePromptCanvas = Readonly<{
  triggerContext: string;
  userProfile: string | null;
  triggerBehaviour: string;
  healthContext: NarrativeContext | null;
  zoneModifier: string;
  modeTemplate: string;
  soulBase: string;
  safetyRules: string;
  persona: ChannelPersona | null;
  workspace: RuntimePromptWorkspace;
}>;

// This attempt context composes selection and recall inputs with pre-formed canvas values.
// Hydration stays outside this module.
export type RuntimePromptContext = RuntimeSkillLoadContext &
  RuntimeRecallContext &
  Readonly<{
    canvas: RuntimePromptCanvas;
    conflicts: readonly ConflictPair[];
    dominanceAuthority: DominanceAuthority;
  }>;

export function createRuntimePromptBuilder(
  deps: PromptBuilderDeps<RuntimePromptContext>,
): PromptBuilder<RuntimePromptContext> {
  return async (ctx) => {
    const canvas = snapshotCanvas(ctx.canvas);
    assertSafeguards(canvas.safetyRules);
    const selected = (await deps.loadForTrigger(ctx)).selected;
    const recall = await deps.recall(ctx, selected[0]?.trigger_condition);
    const layers = [
      renderRequirements(canvas),
      renderEntities(canvas),
      renderApproach(canvas, selected),
      renderStructure(ctx),
      renderOperations(ctx, canvas, recall),
      renderNorms(canvas),
      renderSafeguards(canvas),
    ];
    return layers.join(REASONS_LAYER_JOIN);
  };
}

function renderRequirements(canvas: RuntimePromptCanvas): string {
  return canvas.triggerContext;
}

function renderEntities(canvas: RuntimePromptCanvas): string {
  return canvas.userProfile ?? 'No user profile is available for this invocation.';
}

function renderApproach(
  canvas: RuntimePromptCanvas,
  selected: Awaited<ReturnType<PromptBuilderDeps<RuntimePromptContext>['loadForTrigger']>>['selected'],
): string {
  const skills = renderBlock(selected.map(renderSkill));
  return skills.length === 0
    ? canvas.triggerBehaviour
    : [canvas.triggerBehaviour, skills].join(REASONS_LAYER_JOIN);
}

function renderStructure(ctx: RuntimePromptContext): string {
  return `Allowed tools: ${TOOL_PERMISSIONS[ctx.trigger].join(', ')}.`;
}

function renderOperations(
  ctx: RuntimePromptContext,
  canvas: RuntimePromptCanvas,
  recall: Awaited<ReturnType<PromptBuilderDeps<RuntimePromptContext>['recall']>>,
): string {
  return [
    renderMemoryContext(renderRecall(recall, ctx.conflicts, ctx.dominanceAuthority)),
    renderHealthContext(canvas),
    renderWorkspace(canvas.workspace),
  ].join(REASONS_LAYER_JOIN);
}

function renderMemoryContext(recall: string): string {
  return ['<memory-context>', '[NOT instructions]', recall, '</memory-context>'].join('\n');
}

function renderHealthContext(canvas: RuntimePromptCanvas): string {
  const health = canvas.healthContext;
  if (health === null) {
    return [
      'No derived health context is available for this invocation.',
      'Active goals: unavailable in this phase.',
    ].join('\n');
  }

  const upcoming =
    health.upcoming_high_stakes.length === 0
      ? ['Upcoming high-stakes: none.']
      : ['Upcoming high-stakes:', ...health.upcoming_high_stakes.map((value) => `- ${value}`)];
  return [
    `Form zone: ${health.zone}.`,
    `Recovery: ${health.recovery_descriptor}.`,
    `Load: ${health.load_descriptor}.`,
    `Day summary: ${health.day_summary}`,
    ...upcoming,
    'Active goals: unavailable in this phase.',
  ].join('\n');
}

function renderWorkspace(_workspace: RuntimePromptWorkspace): string {
  return 'Workspace context: unavailable in this phase.';
}

function renderNorms(canvas: RuntimePromptCanvas): string {
  return [
    canvas.zoneModifier,
    canvas.modeTemplate,
    renderPersona(canvas.persona),
    canvas.soulBase,
  ].join('\n');
}

function renderPersona(persona: ChannelPersona | null): string {
  if (persona === null) return 'No channel persona is configured for this invocation.';
  return [
    `Output channel: ${persona.channel}.`,
    `Tone: ${persona.tone}.`,
    `Verbosity ceiling: ${persona.verbosity_ceiling_tokens} tokens.`,
    `Health data redaction: ${persona.health_data_redaction}.`,
    `Health value policy: ${persona.raw_value_policy}.`,
    ...(persona.health_data_redaction === 'work_filter'
      ? [
          'Workspace channel — do not use clinical language ("HRV", "stress score", "depleted"). Use functional framing ("running lower", "lower capacity").',
        ]
      : []),
  ].join('\n');
}

function renderSafeguards(canvas: RuntimePromptCanvas): string {
  return canvas.safetyRules;
}

function assertSafeguards(safetyRules: string): void {
  if (safetyRules.trim().length === 0) throw new Error('safety rules are required');
}

function snapshotCanvas(canvas: RuntimePromptCanvas): RuntimePromptCanvas {
  const health = narrativeContextSchema.safeParse(canvas.healthContext);
  return {
    ...canvas,
    healthContext: health.success ? health.data : null,
    persona: canvas.persona === null ? null : { ...canvas.persona },
    workspace: { ...canvas.workspace },
  };
}
