import type {
  CanaryTokens,
  DerivedHealthDestinationView,
  InvocationInputReference,
  NarrativeContext,
  RecallKey,
  RecallResult,
  RuntimeContextCheckpoint,
  RuntimeContextFailureReason,
  RuntimeContextSource,
  SkillExclusion,
  SourceTaint,
  ToolName,
  TrustedInvocationEnvelope,
  TriggerType,
} from '@waldo/contracts';
import type { ResolvedSkillBudget } from '../skills/budget';

export type ContextSourceKind = RuntimeContextSource['source_kind'];
export type ContextSourceScope = RuntimeContextSource['scope'];

export type ContextSource = Readonly<{
  source_key: string;
  source_kind: ContextSourceKind;
  scope: ContextSourceScope;
  source_taint: SourceTaint;
  produced_at: number;
}>;

export type ContextFragment = Readonly<{
  text: string;
  source: ContextSource;
}>;

export type RuntimeOwnedContextInputs = Readonly<{
  snapshot_ref: string;
  snapshot_at: number;
  canary_tokens: CanaryTokens;
  // A previously persisted V2 context ref is a runtime-owned replay witness, never a prompt
  // source. It lets a fresh adapter prove it reconstructed the same context or fail closed.
  replay_context_ref: string | null;
}>;

// Every adapter that can contribute mutable runtime state attests the frozen request snapshot
// it served. The ref is opaque: it is folded into source/context hashes, never persisted raw.
export type ContextSnapshotAttestation = Readonly<{
  snapshot_ref: string;
  snapshot_at: number;
  revision_ref: string;
}>;

export type ResolvedInvocationInput = Readonly<{
  input_ref: InvocationInputReference['input_ref'];
  content_digest: InvocationInputReference['content_digest'];
  principal_ref: string;
  tenant_ref: string;
  text: string;
  source: ContextSource;
}>;

export type StagedInputSnapshot = Readonly<{
  inputs: readonly ResolvedInvocationInput[];
  snapshot: ContextSnapshotAttestation;
  source: ContextSource;
}>;

export type LocalOwnerBinding = Readonly<{
  principal_ref: string;
  tenant_ref: string;
  local_user_ref: string;
  snapshot: ContextSnapshotAttestation;
  source: ContextSource;
}>;

export type ContextHealthMaterial = Readonly<{
  view: DerivedHealthDestinationView;
  narrative: NarrativeContext;
  source: ContextSource;
}>;

export type RuntimeContextMaterials = Readonly<{
  principal_ref: string;
  tenant_ref: string;
  snapshot: ContextSnapshotAttestation;
  identity: ContextFragment;
  trigger_behaviour: ContextFragment;
  zone_modifier: ContextFragment;
  mode_template: ContextFragment;
  soul_base: ContextFragment;
  safety_rules: ContextFragment;
  health: ContextHealthMaterial | null;
  workspace: readonly ContextFragment[];
  // Recent tool outputs, staged as tool_result sources. Each fragment carries its own taint.
  tool_outputs: readonly ContextFragment[];
  // Count of tool_outputs fragments omitted by the fragment budget (0 = nothing omitted).
  // Loaders always set 0; prepareMaterials computes the actual count during preparation.
  tool_outputs_omitted: number;
}>;

export type StagedInputResolver = Readonly<{
  resolve(request: Readonly<{
    input_refs: readonly InvocationInputReference[];
    principal_ref: string;
    tenant_ref: string;
    snapshot_ref: string;
    snapshot_at: number;
  }>): Promise<StagedInputSnapshot>;
}>;

export type RuntimeContextMaterialsSource = Readonly<{
  load(request: Readonly<{
    principal_ref: string;
    tenant_ref: string;
    snapshot_ref: string;
    snapshot_at: number;
  }>): Promise<RuntimeContextMaterials>;
}>;

export type LocalOwnerBindingResolver = Readonly<{
  bind(request: Readonly<{
    principal_ref: string;
    tenant_ref: string;
    snapshot_ref: string;
    snapshot_at: number;
  }>): Promise<LocalOwnerBinding>;
}>;

export type SystemSkillSnapshot = Readonly<{
  rows: readonly unknown[];
  snapshot: ContextSnapshotAttestation;
  source: ContextSource;
}>;

export type SystemSkillRepository = Readonly<{
  list(request: Readonly<{ snapshot_ref: string; snapshot_at: number }>): Promise<SystemSkillSnapshot>;
}>;

// The five-stage loader accepts explicit per-principal runtime state rather than silently
// assuming that dismissals, drift, or connector availability are empty. The first headless
// lane may provide a frozen local fixture; production state remains a later adapter.
export type SystemSkillRuntimeState = Readonly<{
  principal_ref: string;
  tenant_ref: string;
  snapshot: ContextSnapshotAttestation;
  source: ContextSource;
  connected_connectors: readonly string[];
  dismissed_today: readonly string[];
  provisional_reverted: readonly string[];
  identity_drift: readonly string[];
  priority_pinned: readonly string[];
}>;

export type SystemSkillRuntimeStateSource = Readonly<{
  load(request: Readonly<{
    principal_ref: string;
    tenant_ref: string;
    snapshot_ref: string;
    snapshot_at: number;
  }>): Promise<SystemSkillRuntimeState>;
}>;

export type ContextRecallRequest = Readonly<{
  owner: LocalOwnerBinding;
  recall_key: RecallKey | undefined;
  zone: NarrativeContext['zone'] | undefined;
  hint: string | undefined;
  snapshot_ref: string;
  snapshot_at: number;
  canary_tokens: CanaryTokens;
}>;

export type ContextRecallSnapshot = Readonly<{
  principal_ref: string;
  tenant_ref: string;
  snapshot: ContextSnapshotAttestation;
  // This composer only exposes the current owner-bound temporal capability. It cannot claim
  // a full result until an adapter proves ranked memory, episode/evolution, union, and taint.
  status: 'partial' | 'failed' | 'skipped';
  result: RecallResult;
  source: ContextSource | null;
  capability: 'owner_bound_local_temporal_snapshot';
}>;

export type ContextRecallGateway = Readonly<{
  recall(request: ContextRecallRequest): Promise<ContextRecallSnapshot>;
}>;

export type ContextCompositionPhase =
  | 'admission'
  | 'staged_inputs'
  | 'materials'
  | 'owner_binding'
  | 'skills'
  | 'health'
  | 'recall'
  | 'rendering'
  | 'provenance';

export type ContextComposerUnexpectedErrorObserver = Readonly<{
  record(
    event: Readonly<{
      outcome: 'assembly_failed';
      phase: ContextCompositionPhase;
      error_kind: 'error' | 'non_error';
    }>,
  ): void | Promise<void>;
}>;

export type ContextComposerDependencies = Readonly<{
  staged_inputs: StagedInputResolver;
  materials: RuntimeContextMaterialsSource;
  owner_binding: LocalOwnerBindingResolver;
  system_skills: SystemSkillRepository;
  system_skill_state: SystemSkillRuntimeStateSource;
  skill_budget: ResolvedSkillBudget;
  recall: ContextRecallGateway;
  unexpected_error_observer?: ContextComposerUnexpectedErrorObserver;
}>;

export type ContextCompositionEvidence = Readonly<{
  layers: readonly ContextLayer[];
  trigger: TriggerType;
  variant: TrustedInvocationEnvelope['runtime_binding']['variant'];
  tool_acl: readonly ToolName[];
  snapshot_ref: string;
  prompt_digest: string;
  skills: Readonly<{
    admission_mode: 'active_system_only';
    selected: readonly string[];
    excluded: readonly SkillExclusion[];
  }>;
  recall: Readonly<{
    status: ContextRecallSnapshot['status'];
    invoked: boolean;
    key: RecallKey | undefined;
    hint_skill: string | null;
    capability: ContextRecallSnapshot['capability'];
  }>;
}>;

export const CONTEXT_LAYERS = Object.freeze([
  'requirements',
  'identity',
  'approach',
  'tools',
  'operations',
  'voice',
  'safety',
] as const);
export type ContextLayer = (typeof CONTEXT_LAYERS)[number];

// The content-free failure vocabulary is contract-owned so ContextComposer and RunLoopDO cannot
// drift into two representations of the same replay-safe fact.
export type ContextCompositionFailureCode = RuntimeContextFailureReason;

export type ContextCompositionResult =
  | Readonly<{
      ok: true;
      prompt: string;
      checkpoint: RuntimeContextCheckpoint;
      evidence: ContextCompositionEvidence;
    }>
  | Readonly<{
      ok: false;
      failure: Readonly<{ code: ContextCompositionFailureCode }>;
    }>;

export type ContextComposer = Readonly<{
  compose(
    trustedInvocation: TrustedInvocationEnvelope,
    runtimeOwnedInputs: RuntimeOwnedContextInputs,
  ): Promise<ContextCompositionResult>;
}>;
