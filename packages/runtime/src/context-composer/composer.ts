// Private orchestration implementation; the public ContextComposer seam is re-exported by index.ts.
import {
  TOOL_PERMISSIONS,
  runtimeContextCheckpointSchema,
  trustedInvocationEnvelopeSchema,
  type SkillExclusion,
} from '@waldo/contracts';
import type {
  ContextComposer,
  ContextComposerDependencies,
  ContextComposerUnexpectedErrorObserver,
  ContextCompositionEvidence,
  ContextCompositionPhase,
} from './types';
import { CONTEXT_LAYERS } from './types';
import { assembleReasonsPrompt, renderProviderPrompt } from './prompt';
import { snapshotData, validateRuntimeInputs } from './admission';
import { loadSystemSkills } from './skills';
import {
  loadLocalOwnerBinding,
  loadRuntimeContextMaterials,
  loadStagedInputs,
  prepareHealth,
} from './materials';
import { loadRecall, recallKeyFor } from './recall';
import {
  FrozenSnapshotReplayGuard,
  ProvenanceCollector,
  type FrozenSnapshotReplayLease,
} from './provenance';
import { FailClosed } from './faults';

export {
  ContextRecallFailClosedError,
  ContextRecallUnavailableError,
  ContextSourceRejectedError,
  ContextSourceUnavailableError,
} from './faults';


export function createContextComposer(deps: ContextComposerDependencies): ContextComposer {
  const replayGuard = new FrozenSnapshotReplayGuard();
  return Object.freeze({
    compose: async (trustedInvocation, runtimeOwnedInputs) => {
      let replayLease: FrozenSnapshotReplayLease | undefined;
      let phase: ContextCompositionPhase = 'admission';
      try {
        let invocationValue: unknown;
        try {
          invocationValue = snapshotData(trustedInvocation);
        } catch {
          throw new FailClosed('invalid_trusted_invocation');
        }
        const invocation = trustedInvocationEnvelopeSchema.safeParse(invocationValue);
        if (!invocation.success) throw new FailClosed('invalid_trusted_invocation');
        const inputs = validateRuntimeInputs(runtimeOwnedInputs, invocation.data);
        replayLease = replayGuard.begin(invocation.data, inputs);
        const provenance = new ProvenanceCollector(invocation.data, inputs);

        phase = 'staged_inputs';
        const stagedInputs = await loadStagedInputs(deps.staged_inputs, invocation.data, inputs, provenance);
        phase = 'materials';
        const materials = await loadRuntimeContextMaterials(deps.materials, invocation.data, inputs, provenance);
        phase = 'owner_binding';
        const owner = await loadLocalOwnerBinding(deps.owner_binding, invocation.data, inputs, provenance);
        phase = 'skills';
        const skills = await loadSystemSkills(
          deps.system_skills,
          deps.system_skill_state,
          deps.skill_budget,
          invocation.data,
          inputs,
          provenance,
        );
        phase = 'health';
        const health = prepareHealth(
          materials.health,
          inputs.canary_tokens,
          provenance,
          materials.snapshot.revision_ref,
          inputs.snapshot_at,
        );
        const recallKey = recallKeyFor(invocation.data.runtime_binding.trigger, invocation.data.runtime_binding.variant);
        phase = 'recall';
        const recall = await loadRecall(
          deps.recall,
          owner,
          recallKey,
          health?.view.form_zone,
          skills.selected[0]?.trigger_condition,
          inputs,
          provenance,
        );

        phase = 'rendering';
        const rendered = await renderProviderPrompt(
          assembleReasonsPrompt(invocation.data, stagedInputs, materials, skills.selected, recall, health),
          inputs.canary_tokens,
        );
        if (!rendered.ok) throw new FailClosed(rendered.failure);
        const prompt = rendered.prompt;
        phase = 'provenance';
        const checkpoint = await provenance.checkpoint(rendered.identity);
        const checkedCheckpoint = runtimeContextCheckpointSchema.safeParse(checkpoint);
        if (!checkedCheckpoint.success) throw new FailClosed('provenance_invalid');
        if (
          inputs.replay_context_ref !== null &&
          inputs.replay_context_ref !== checkedCheckpoint.data.context_ref
        ) {
          throw new FailClosed('provenance_invalid');
        }

        const promptDigest = rendered.identity.prompt_digest;
        const evidence: ContextCompositionEvidence = Object.freeze({
          layers: CONTEXT_LAYERS,
          trigger: invocation.data.runtime_binding.trigger,
          variant: invocation.data.runtime_binding.variant,
          tool_acl: Object.freeze([...TOOL_PERMISSIONS[invocation.data.runtime_binding.trigger]]),
          snapshot_ref: inputs.snapshot_ref,
          prompt_digest: promptDigest,
          skills: Object.freeze({
            admission_mode: 'active_system_only',
            selected: Object.freeze(skills.selected.map((skill) => skill.name)),
            excluded: Object.freeze(skills.excluded.map(copyExclusion)),
          }),
          recall: Object.freeze({
            status: recall.status,
            invoked: true,
            key: recallKey,
            hint_skill: skills.selected[0]?.name ?? null,
            capability: recall.capability,
          }),
        });

        replayLease.assertStable(promptDigest, checkedCheckpoint.data);

        return Object.freeze({
          ok: true as const,
          prompt,
          checkpoint: checkedCheckpoint.data,
          evidence,
        });
      } catch (error) {
        if (error instanceof FailClosed) {
          console.warn(JSON.stringify({ event: 'context_fail_closed', phase, code: error.code }));
          return Object.freeze({ ok: false as const, failure: Object.freeze({ code: error.code }) });
        }
        await observeUnexpectedError(deps.unexpected_error_observer, phase, error);
        return Object.freeze({
          ok: false as const,
          failure: Object.freeze({ code: 'assembly_failed' as const }),
        });
      } finally {
        replayLease?.release();
      }
    },
  });
}

async function observeUnexpectedError(
  observer: ContextComposerUnexpectedErrorObserver | undefined,
  phase: ContextCompositionPhase,
  cause: unknown,
): Promise<void> {
  if (observer === undefined) return;
  const event = Object.freeze({
    outcome: 'assembly_failed' as const,
    phase,
    error_kind: cause instanceof Error ? 'error' as const : 'non_error' as const,
  });
  try {
    // The observer is an incident signal, not an error transport. In particular, adapter
    // messages can contain source content or credentials, so the raw thrown value never
    // crosses this public dependency seam.
    await observer.record(event);
  } catch {
    // The observer is diagnostic-only; its own failure must never expose or replace the
    // content-free assembly boundary.
  }
}

function copyExclusion(exclusion: SkillExclusion): SkillExclusion {
  return Object.freeze({ skill_name: exclusion.skill_name, reason: exclusion.reason });
}
