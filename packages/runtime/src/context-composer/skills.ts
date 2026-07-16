import { skillRowSchema, type Skill, type SkillExclusion, type TrustedInvocationEnvelope } from '@waldo/contracts';
import { RuntimeSkillLoader, type RuntimeSkillLoadContext } from '../skills/loader';
import type { ResolvedSkillBudget } from '../skills/budget';
import {
  attestSnapshot,
  loadExpectedSource,
  recordWithKeys,
  snapshotAdapterPayload,
  snapshotArray,
  snapshotContextSource,
} from './admission';
import { compareCodeUnits, stableJson } from './canonical';
import { FailClosed } from './faults';
import { ProvenanceCollector } from './provenance';
import { prepareSystemSkill } from './source-sanitisation';
import type {
  ContextCompositionFailureCode,
  RuntimeOwnedContextInputs,
  SystemSkillRepository,
  SystemSkillRuntimeState,
  SystemSkillRuntimeStateSource,
} from './types';

const MAX_SKILL_BODY_CHARS = 2_400;
const MAX_SKILL_TRIGGER_CONDITION_CHARS = 800;
const MAX_SKILL_TRIGGER_TYPES = 16;
const MAX_SKILL_REQUIRED_TOOLS = 32;
const MAX_SKILL_REQUIRED_CONNECTORS = 16;
const MAX_SKILL_ROWS = 24;

export type LoadedSkills = Readonly<{
  selected: readonly Skill[];
  excluded: readonly SkillExclusion[];
}>;

export async function loadSystemSkills(
  repository: SystemSkillRepository,
  stateSource: SystemSkillRuntimeStateSource,
  skillBudget: ResolvedSkillBudget,
  invocation: TrustedInvocationEnvelope,
  inputs: RuntimeOwnedContextInputs,
  provenance: ProvenanceCollector,
): Promise<LoadedSkills> {
  const response = await loadExpectedSource(
    () => repository.list({
      snapshot_ref: inputs.snapshot_ref,
      snapshot_at: inputs.snapshot_at,
    }),
    'skill_snapshot_invalid',
  );
  const rawSnapshot = snapshotAdapterPayload(response, 'skill_snapshot_invalid');
  const snapshot = recordWithKeys(rawSnapshot, ['rows', 'snapshot', 'source'], 'skill_snapshot_invalid');
  const rows = snapshotArray(snapshot.rows);
  if (rows === null || rows.length > MAX_SKILL_ROWS) {
    throw new FailClosed('skill_snapshot_invalid');
  }
  const skillSnapshot = attestSnapshot(snapshot.snapshot, inputs, provenance, 'system_skills', 'skill_snapshot_invalid');
  const snapshotSource = snapshotContextSource(snapshot.source, 'skill_snapshot_invalid');
  const names = new Set<string>();
  const validatedRows: ReturnType<typeof skillRowSchema.parse>[] = [];
  for (const value of rows) {
    const row = skillRowSchema.safeParse(value);
    if (!row.success) throw new FailClosed('skill_row_invalid');
    if (row.data.status !== 'active' || row.data.provenance !== 'system') {
      // This repository is deliberately system-only. A source that returns another owner class
      // is not allowed to expose even its metadata through the composition evidence.
      throw new FailClosed('skill_snapshot_invalid');
    }
    if (
      row.data.body_markdown.length > MAX_SKILL_BODY_CHARS ||
      row.data.trigger_condition.length > MAX_SKILL_TRIGGER_CONDITION_CHARS ||
      row.data.trigger_types.length > MAX_SKILL_TRIGGER_TYPES ||
      row.data.required_tools.length > MAX_SKILL_REQUIRED_TOOLS ||
      row.data.required_connectors.length > MAX_SKILL_REQUIRED_CONNECTORS ||
      !Number.isSafeInteger(Date.parse(row.data.created_at)) ||
      Date.parse(row.data.created_at) > inputs.snapshot_at ||
      (row.data.last_used !== null &&
        (!Number.isSafeInteger(Date.parse(row.data.last_used)) || Date.parse(row.data.last_used) > inputs.snapshot_at))
    ) {
      throw new FailClosed('skill_content_oversize');
    }
    // A currently-active row that claims archival, or a curation timestamp after this source
    // snapshot, cannot prove the historical system-skill state. There is no row history here,
    // so refuse it rather than applying today's skill to an older invocation snapshot.
    if (
      row.data.archived_at !== null ||
      (row.data.last_curated_at !== null && Date.parse(row.data.last_curated_at) > inputs.snapshot_at)
    ) {
      throw new FailClosed('skill_snapshot_invalid');
    }
    if (names.has(row.data.name)) throw new FailClosed('skill_snapshot_invalid');
    names.add(row.data.name);
    validatedRows.push(canonicalSkillRow(row.data));
  }
  validatedRows.sort(compareSkillRows);
  provenance.add(snapshotSource, {
    source_kind: 'runtime_metadata',
    scope: 'system',
    source_taint: null,
  }, stableJson(validatedRows), skillSnapshot.revision_ref);

  const state = await loadSystemSkillRuntimeState(stateSource, invocation, inputs, provenance);
  const candidates = validatedRows.map((row) => prepareSystemSkill(row, inputs.canary_tokens));

  const loader = new RuntimeSkillLoader({
    systemSkills: candidates,
    connectorSkills: [],
    mutableReader: { load: async () => ({ ok: true as const, skills: [] }) },
  });
  const context: RuntimeSkillLoadContext = {
    trigger: invocation.runtime_binding.trigger,
    canaryTokens: inputs.canary_tokens,
    connectedConnectors: new Set(state.connected_connectors),
    dismissedToday: new Set(state.dismissed_today),
    provisionalReverted: new Set(state.provisional_reverted),
    identityDrift: new Set(state.identity_drift),
    priorityPinned: new Set(state.priority_pinned),
    skillBudget,
  };
  const selection = await loadExpectedSource(
    () => loader.loadForTrigger(context),
    'skill_snapshot_invalid',
  );
  for (const skill of selection.selected) {
    provenance.add(
      {
        source_key: `system-skill:${skill.name}:v${skill.version}`,
        source_kind: 'skill',
        scope: 'system',
        source_taint: null,
        produced_at: Date.parse(skill.created_at),
      },
      { source_kind: 'skill', scope: 'system', source_taint: null },
      stableJson(skill),
      skillSnapshot.revision_ref,
    );
  }
  return Object.freeze({
    selected: Object.freeze([...selection.selected]),
    excluded: Object.freeze(selection.excluded.map(copyExclusion).sort(compareExclusions)),
  });
}

async function loadSystemSkillRuntimeState(
  source: SystemSkillRuntimeStateSource,
  invocation: TrustedInvocationEnvelope,
  inputs: RuntimeOwnedContextInputs,
  provenance: ProvenanceCollector,
): Promise<SystemSkillRuntimeState> {
  const response = await loadExpectedSource(
    () => source.load({
      principal_ref: invocation.verified_authority.principal_ref,
      tenant_ref: invocation.verified_authority.tenant_ref,
      snapshot_ref: inputs.snapshot_ref,
      snapshot_at: inputs.snapshot_at,
    }),
    'skill_snapshot_invalid',
  );
  const raw = snapshotAdapterPayload(response, 'skill_snapshot_invalid');
  const state = recordWithKeys(
    raw,
    [
      'principal_ref',
      'tenant_ref',
      'snapshot',
      'source',
      'connected_connectors',
      'dismissed_today',
      'provisional_reverted',
      'identity_drift',
      'priority_pinned',
    ],
    'skill_snapshot_invalid',
  );
  if (
    state.principal_ref !== invocation.verified_authority.principal_ref ||
    state.tenant_ref !== invocation.verified_authority.tenant_ref
  ) {
    throw new FailClosed('skill_snapshot_invalid');
  }
  const snapshot = attestSnapshot(state.snapshot, inputs, provenance, 'system_skill_state', 'skill_snapshot_invalid');
  const stateSource = snapshotContextSource(state.source, 'skill_snapshot_invalid');
  const connectedConnectors = boundedStringSet(state.connected_connectors, 'skill_snapshot_invalid');
  const dismissedToday = boundedStringSet(state.dismissed_today, 'skill_snapshot_invalid');
  const provisionalReverted = boundedStringSet(state.provisional_reverted, 'skill_snapshot_invalid');
  const identityDrift = boundedStringSet(state.identity_drift, 'skill_snapshot_invalid');
  const priorityPinned = boundedStringSet(state.priority_pinned, 'skill_snapshot_invalid');
  provenance.add(
    stateSource,
    { source_kind: 'runtime_metadata', scope: 'principal', source_taint: null },
    stableJson({
      connected_connectors: connectedConnectors,
      dismissed_today: dismissedToday,
      provisional_reverted: provisionalReverted,
      identity_drift: identityDrift,
      priority_pinned: priorityPinned,
    }),
    snapshot.revision_ref,
  );
  return Object.freeze({
    principal_ref: invocation.verified_authority.principal_ref,
    tenant_ref: invocation.verified_authority.tenant_ref,
    snapshot,
    source: stateSource,
    connected_connectors: connectedConnectors,
    dismissed_today: dismissedToday,
    provisional_reverted: provisionalReverted,
    identity_drift: identityDrift,
    priority_pinned: priorityPinned,
  });
}

function boundedStringSet(value: unknown, failure: ContextCompositionFailureCode): readonly string[] {
  const values = snapshotArray(value);
  if (values === null || values.length > MAX_SKILL_ROWS || values.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 128)) {
    throw new FailClosed(failure);
  }
  const unique = [...new Set(values as string[])].sort(compareCodeUnits);
  if (unique.length !== values.length) throw new FailClosed(failure);
  return Object.freeze(unique);
}

function copyExclusion(exclusion: SkillExclusion): SkillExclusion {
  return Object.freeze({ skill_name: exclusion.skill_name, reason: exclusion.reason });
}

function compareExclusions(left: SkillExclusion, right: SkillExclusion): number {
  return compareCodeUnits(left.skill_name, right.skill_name) || compareCodeUnits(left.reason, right.reason);
}

function canonicalSkillRow(
  row: ReturnType<typeof skillRowSchema.parse>,
): ReturnType<typeof skillRowSchema.parse> {
  return Object.freeze({
    ...row,
    trigger_types: Object.freeze([...row.trigger_types].sort(compareCodeUnits)),
    required_tools: Object.freeze([...row.required_tools].sort(compareCodeUnits)),
    required_connectors: Object.freeze([...row.required_connectors].sort(compareCodeUnits)),
  }) as ReturnType<typeof skillRowSchema.parse>;
}

function compareSkillRows(
  left: ReturnType<typeof skillRowSchema.parse>,
  right: ReturnType<typeof skillRowSchema.parse>,
): number {
  return compareCodeUnits(left.name, right.name) || compareCodeUnits(stableJson(left), stableJson(right));
}
