import {
  derivedHealthDestinationViewSchema,
  narrativeContextSchema,
  type CanaryTokens,
  type NarrativeContext,
  type TrustedInvocationEnvelope,
} from '@waldo/contracts';
import { prepareWithScribe } from '../scribe/prepare';
import {
  attestSnapshot,
  loadExpectedSource,
  recordWithKeys,
  snapshotAdapterPayload,
  snapshotArray,
  snapshotContextSource,
  snapshotHealthMaterial,
  snapshotResolvedInput,
} from './admission';
import { compareCodeUnits, sha256Prefixed, stableJson } from './canonical';
import { FailClosed } from './faults';
import { isBoundedNarrative } from './prompt';
import { ProvenanceCollector } from './provenance';
import { preparePromptSourceText } from './source-sanitisation';
import type {
  ContextFragment,
  ContextHealthMaterial,
  ContextSource,
  LocalOwnerBinding,
  LocalOwnerBindingResolver,
  RuntimeContextMaterials,
  RuntimeContextMaterialsSource,
  RuntimeOwnedContextInputs,
  StagedInputResolver,
} from './types';

const MAX_INPUT_CHARS = 2_000;
const MAX_INPUT_TOTAL_CHARS = 6_000;
const MAX_CONTEXT_FRAGMENT_CHARS = 2_000;
const MAX_WORKSPACE_FRAGMENTS = 4;

export async function loadStagedInputs(
  resolver: StagedInputResolver,
  invocation: TrustedInvocationEnvelope,
  inputs: RuntimeOwnedContextInputs,
  provenance: ProvenanceCollector,
): Promise<readonly string[]> {
  const response = await loadExpectedSource(
    () => resolver.resolve({
      input_refs: invocation.input_refs,
      principal_ref: invocation.verified_authority.principal_ref,
      tenant_ref: invocation.verified_authority.tenant_ref,
      snapshot_ref: inputs.snapshot_ref,
      snapshot_at: inputs.snapshot_at,
    }),
    'input_integrity',
  );
  const raw = snapshotAdapterPayload(response, 'input_integrity');
  const resolved = recordWithKeys(raw, ['inputs', 'snapshot', 'source'], 'input_integrity');
  const snapshot = attestSnapshot(resolved.snapshot, inputs, provenance, 'staged_inputs', 'input_integrity');
  const snapshotSource = snapshotContextSource(resolved.source, 'input_integrity');
  provenance.add(
    snapshotSource,
    { source_kind: 'runtime_metadata', scope: 'invocation', source_taint: null },
    stableJson(invocation.input_refs),
    snapshot.revision_ref,
  );
  const resolvedSnapshot = snapshotArray(resolved.inputs);
  if (resolvedSnapshot === null || resolvedSnapshot.length !== invocation.input_refs.length) {
    throw new FailClosed('input_integrity');
  }

  const texts: string[] = [];
  let total = 0;
  for (let index = 0; index < invocation.input_refs.length; index += 1) {
    const expected = invocation.input_refs[index];
    const actual = snapshotResolvedInput(resolvedSnapshot[index]);
    if (
      expected === undefined ||
      actual === undefined ||
      actual.input_ref !== expected.input_ref ||
      actual.content_digest !== expected.content_digest ||
      actual.principal_ref !== invocation.verified_authority.principal_ref ||
      actual.tenant_ref !== invocation.verified_authority.tenant_ref ||
      typeof actual.text !== 'string' ||
      actual.text.length === 0 ||
      actual.text.length > MAX_INPUT_CHARS
    ) {
      throw new FailClosed('input_integrity');
    }
    if ((await sha256Prefixed(actual.text)) !== expected.content_digest) {
      throw new FailClosed('input_integrity');
    }
    total += actual.text.length;
    if (total > MAX_INPUT_TOTAL_CHARS) throw new FailClosed('input_integrity');
    provenance.add(
      actual.source,
      { source_kind: 'invocation_input', scope: 'invocation', source_taint: null },
      stableJson({ input_ref: actual.input_ref, content_digest: actual.content_digest }),
      snapshot.revision_ref,
    );
    texts.push(preparePromptSourceText(actual.text, actual.source.source_taint, inputs.canary_tokens));
  }
  return Object.freeze(texts);
}

export async function loadRuntimeContextMaterials(
  source: RuntimeContextMaterialsSource,
  invocation: TrustedInvocationEnvelope,
  inputs: RuntimeOwnedContextInputs,
  provenance: ProvenanceCollector,
): Promise<RuntimeContextMaterials> {
  const response = await loadExpectedSource(
    () => source.load({
      principal_ref: invocation.verified_authority.principal_ref,
      tenant_ref: invocation.verified_authority.tenant_ref,
      snapshot_ref: inputs.snapshot_ref,
      snapshot_at: inputs.snapshot_at,
    }),
    'materials_unavailable',
  );
  const raw = snapshotAdapterPayload(response, 'materials_unavailable');
  const materials = recordWithKeys(raw, [
    'principal_ref',
    'tenant_ref',
    'snapshot',
    'identity',
    'trigger_behaviour',
    'zone_modifier',
    'mode_template',
    'soul_base',
    'safety_rules',
    'health',
    'workspace',
  ], 'materials_unavailable');
  if (
    materials.principal_ref !== invocation.verified_authority.principal_ref ||
    materials.tenant_ref !== invocation.verified_authority.tenant_ref
  ) {
    throw new FailClosed('identity_mismatch');
  }
  const snapshot = attestSnapshot(materials.snapshot, inputs, provenance, 'materials', 'materials_unavailable');

  const identity = prepareMandatoryFragment(materials.identity, inputs, provenance, snapshot.revision_ref, {
    source_kind: 'runtime_metadata',
    scope: 'principal',
    source_taint: null,
  });
  const trigger_behaviour = prepareMandatoryFragment(
    materials.trigger_behaviour,
    inputs,
    provenance,
    snapshot.revision_ref,
    {
      source_kind: 'runtime_metadata',
      scope: 'system',
      source_taint: null,
    },
  );
  const zone_modifier = prepareMandatoryFragment(materials.zone_modifier, inputs, provenance, snapshot.revision_ref, {
    source_kind: 'runtime_metadata',
    scope: 'system',
    source_taint: null,
  });
  const mode_template = prepareMandatoryFragment(materials.mode_template, inputs, provenance, snapshot.revision_ref, {
    source_kind: 'runtime_metadata',
    scope: 'system',
    source_taint: null,
  });
  const soul_base = prepareMandatoryFragment(materials.soul_base, inputs, provenance, snapshot.revision_ref, {
    source_kind: 'runtime_metadata',
    scope: 'system',
    source_taint: null,
  });
  const safety_rules = prepareMandatoryFragment(materials.safety_rules, inputs, provenance, snapshot.revision_ref, {
    source_kind: 'runtime_metadata',
    source_taint: null,
    scope: 'system',
  });

  const workspaceValues = snapshotArray(materials.workspace);
  if (workspaceValues === null || workspaceValues.length > MAX_WORKSPACE_FRAGMENTS) {
    throw new FailClosed('materials_unavailable');
  }
  const workspace = workspaceValues.map((fragment) => {
    const prepared = prepareMandatoryFragment(
      fragment,
      inputs,
      provenance,
      snapshot.revision_ref,
      { source_taint: 'external' },
      true,
    );
    if (
      prepared.source.source_kind !== 'connector_snapshot' &&
      prepared.source.source_kind !== 'workspace_snapshot'
    ) {
      throw new FailClosed('provenance_invalid');
    }
    if (
      prepared.source.scope !== 'invocation' &&
      prepared.source.scope !== 'principal' &&
      prepared.source.scope !== 'tenant'
    ) {
      throw new FailClosed('provenance_invalid');
    }
    return prepared;
  });
  const health = snapshotHealthMaterial(materials.health, 'health_context_invalid');
  return Object.freeze({
    principal_ref: invocation.verified_authority.principal_ref,
    tenant_ref: invocation.verified_authority.tenant_ref,
    snapshot,
    identity,
    trigger_behaviour,
    zone_modifier,
    mode_template,
    soul_base,
    safety_rules,
    health,
    workspace: Object.freeze([...workspace].sort(compareFragments)),
  });
}

export async function loadLocalOwnerBinding(
  resolver: LocalOwnerBindingResolver,
  invocation: TrustedInvocationEnvelope,
  inputs: RuntimeOwnedContextInputs,
  provenance: ProvenanceCollector,
): Promise<LocalOwnerBinding> {
  const response = await loadExpectedSource(
    () => resolver.bind({
      principal_ref: invocation.verified_authority.principal_ref,
      tenant_ref: invocation.verified_authority.tenant_ref,
      snapshot_ref: inputs.snapshot_ref,
      snapshot_at: inputs.snapshot_at,
    }),
    'owner_binding_mismatch',
  );
  const raw = snapshotAdapterPayload(response, 'owner_binding_mismatch');
  const binding = recordWithKeys(raw, ['principal_ref', 'tenant_ref', 'local_user_ref', 'snapshot', 'source'], 'owner_binding_mismatch');
  if (
    binding.principal_ref !== invocation.verified_authority.principal_ref ||
    binding.tenant_ref !== invocation.verified_authority.tenant_ref ||
    typeof binding.local_user_ref !== 'string' ||
    binding.local_user_ref.length === 0 ||
    binding.local_user_ref.length > 256
  ) {
    throw new FailClosed('owner_binding_mismatch');
  }
  const snapshot = attestSnapshot(binding.snapshot, inputs, provenance, 'owner_binding', 'owner_binding_mismatch');
  const source = snapshotContextSource(binding.source, 'owner_binding_mismatch');
  provenance.add(source, {
    source_kind: 'runtime_metadata',
    scope: 'principal',
    source_taint: null,
  }, stableJson({ owner_binding: binding.local_user_ref }), snapshot.revision_ref);
  return Object.freeze({
    principal_ref: binding.principal_ref,
    tenant_ref: binding.tenant_ref,
    local_user_ref: binding.local_user_ref,
    snapshot,
    source,
  });
}

export function prepareHealth(
  health: ContextHealthMaterial | null,
  canaries: CanaryTokens,
  provenance: ProvenanceCollector,
  revisionRef: string,
  snapshotAt: number,
): ContextHealthMaterial | null {
  if (health === null) return null;
  const view = derivedHealthDestinationViewSchema.safeParse(health.view);
  const narrative = narrativeContextSchema.safeParse(health.narrative);
  if (
    !view.success ||
    !narrative.success ||
    !view.data.destination_eligibility.includes('trigger_prompt') ||
    narrative.data.zone !== view.data.form_zone ||
    !Number.isSafeInteger(Date.parse(narrative.data.compiled_at)) ||
    Date.parse(narrative.data.compiled_at) > snapshotAt ||
    !isBoundedNarrative(narrative.data)
  ) {
    throw new FailClosed('health_context_invalid');
  }
  provenance.add(
    health.source,
    { source_kind: 'derived_health_view' },
    stableJson({ view: view.data, narrative: narrative.data }),
    revisionRef,
  );
  if (
    health.source.source_kind !== 'derived_health_view' ||
    health.source.source_taint !== null ||
    (health.source.scope !== 'invocation' && health.source.scope !== 'principal')
  ) {
    throw new FailClosed('health_context_invalid');
  }
  const preparedView = prepareWithScribe(
    view.data,
    derivedHealthDestinationViewSchema,
    'system_prompt',
    null,
    canaries,
  );
  if (!preparedView.ok) throw new FailClosed('sanitisation_failed');
  const preparedNarrative = {
    ...narrative.data,
    day_summary: preparePromptSourceText(narrative.data.day_summary, null, canaries),
    active_goals: narrative.data.active_goals.map((item) => preparePromptSourceText(item, null, canaries)),
    upcoming_high_stakes: narrative.data.upcoming_high_stakes.map((item) =>
      preparePromptSourceText(item, null, canaries),
    ),
  };
  return Object.freeze({
    view: preparedView.value,
    narrative: Object.freeze({
      ...preparedNarrative,
      active_goals: Object.freeze([...preparedNarrative.active_goals]),
      upcoming_high_stakes: Object.freeze([...preparedNarrative.upcoming_high_stakes]),
    }) as NarrativeContext,
    source: health.source,
  });
}

function prepareMandatoryFragment(
  fragment: unknown,
  inputs: RuntimeOwnedContextInputs,
  provenance: ProvenanceCollector,
  revisionRef: string,
  expected: Partial<Pick<ContextSource, 'source_kind' | 'scope' | 'source_taint'>> = {},
  allowScribeRewrite = false,
): ContextFragment {
  const record = recordWithKeys(fragment, ['text', 'source'], 'mandatory_context_missing');
  if (typeof record.text !== 'string' || record.text.trim().length === 0 || record.text.length > MAX_CONTEXT_FRAGMENT_CHARS) {
    throw new FailClosed('mandatory_context_missing');
  }
  const source = snapshotContextSource(record.source, 'provenance_invalid');
  const prepared = preparePromptSourceText(record.text, source.source_taint, inputs.canary_tokens);
  if (!allowScribeRewrite && prepared !== record.text) {
    throw new FailClosed('sanitisation_failed');
  }
  provenance.add(source, expected, stableJson({ text: prepared }), revisionRef);
  return Object.freeze({ text: prepared, source });
}

function compareFragments(left: ContextFragment, right: ContextFragment): number {
  return compareCodeUnits(fragmentOrderingKey(left), fragmentOrderingKey(right));
}

function fragmentOrderingKey(fragment: ContextFragment): string {
  return stableJson({
    source_key: fragment.source.source_key,
    source_kind: fragment.source.source_kind,
    scope: fragment.source.scope,
    produced_at: fragment.source.produced_at,
    text: fragment.text,
  });
}
