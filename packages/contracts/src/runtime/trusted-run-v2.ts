import { z } from 'zod';
import { sourceTaintSchema } from '../memory/sanitise';
import { TOOL_PERMISSIONS, toolNameSchema } from '../tools/permissions';
import { runtimeInvocationV2RecordSchema, type RuntimeToolCheckpoint } from './invocation';
import { gatewayStepSchema } from './routing';

const opaqueRef = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-f0-9]{32}$`), {
    error: `${prefix} reference must be an opaque 32-character hexadecimal token`,
  });

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

// These identifiers are runtime-derived and content-free. `effect_ref` is the durable witness;
// `idempotency_key` is the adapter/tool reconciliation key. Neither permits caller input or a
// raw request/prompt/result to enter the V2 sidecar.
export const trustedRunV2EffectRefSchema = opaqueRef('eff');
export const trustedRunV2EffectIdempotencyKeySchema = opaqueRef('idk');

const effectIdentityShape = {
  effect_ref: trustedRunV2EffectRefSchema,
  idempotency_key: trustedRunV2EffectIdempotencyKeySchema,
  request_digest: sha256HexSchema,
} as const;

// This is deliberately the smallest provider execution witness that can make a keyed recovery
// meaningful after the ephemeral prompt has been discarded. It binds the adapter receipt to the
// selected provider/model step and fallback semantics, but contains neither a request nor text.
export const trustedRunV2ProviderExecutionWitnessSchema = z.strictObject({
  step: gatewayStepSchema,
  context: z.enum(['full_context', 'reduced_context']),
  fallback_step: z.enum(['spend_cap_clamp', 'configured_model', 'gateway_chain']),
});
export type TrustedRunV2ProviderExecutionWitness = z.infer<
  typeof trustedRunV2ProviderExecutionWitnessSchema
>;

const providerPlanEffectSchema = z.strictObject({
  kind: z.literal('provider_plan'),
  ...effectIdentityShape,
  iteration: z.int().positive().max(16),
  execution: trustedRunV2ProviderExecutionWitnessSchema,
});

const providerObserveEffectSchema = z.strictObject({
  kind: z.literal('provider_observe'),
  ...effectIdentityShape,
  iteration: z.int().positive().max(16),
  execution: trustedRunV2ProviderExecutionWitnessSchema,
});

export const trustedRunV2ToolEffectWitnessSchema = z.strictObject({
  kind: z.literal('tool'),
  ...effectIdentityShape,
  call_ref: opaqueRef('call'),
  tool: toolNameSchema,
  args_hash: sha256HexSchema,
  // The post-effect checkpoint must retain the exact pre-tool taint decision without retaining
  // arguments or source text, so key-only recovery can write the same bounded guard witness.
  argument_taint: sourceTaintSchema,
});
export type TrustedRunV2ToolEffectWitness = z.infer<typeof trustedRunV2ToolEffectWitnessSchema>;

export const trustedRunV2ProviderEffectWitnessSchema = z.discriminatedUnion('kind', [
  providerPlanEffectSchema,
  providerObserveEffectSchema,
]);
export type TrustedRunV2ProviderEffectWitness = z.infer<
  typeof trustedRunV2ProviderEffectWitnessSchema
>;

// Exactly one effect can be in doubt at a time. The RunLoop writes this intent before crossing an
// external boundary, then clears it atomically with the corresponding bounded receipt.
export const trustedRunV2PendingEffectSchema = z.discriminatedUnion('kind', [
  providerPlanEffectSchema,
  providerObserveEffectSchema,
  trustedRunV2ToolEffectWitnessSchema,
]);
export type TrustedRunV2PendingEffect = z.infer<typeof trustedRunV2PendingEffectSchema>;

export type TrustedRunV2SettledToolCheckpoint =
  | Extract<RuntimeToolCheckpoint, { status: 'completed' }>
  | (Extract<RuntimeToolCheckpoint, { status: 'blocked' }> & {
      effect_receipt: NonNullable<
        Extract<RuntimeToolCheckpoint, { status: 'blocked' }>['effect_receipt']
      >;
    });

export const trustedRunV2SnapshotSchema = z.strictObject({
  snapshot_ref: opaqueRef('snp'),
  snapshot_at: z.int().nonnegative(),
});
export type TrustedRunV2Snapshot = z.infer<typeof trustedRunV2SnapshotSchema>;

// The existing plan and synthesis references are the provider receipts. Their effect witnesses
// bind a durable response to the idempotency key that crossed the provider boundary.
export const trustedRunV2PlanReceiptSchema = z
  .strictObject({
    iteration: z.int().positive().max(16),
    plan_ref: opaqueRef('pln'),
    plan_digest: sha256HexSchema,
    effect: trustedRunV2ProviderEffectWitnessSchema,
  })
  .refine((receipt) => receipt.iteration === receipt.effect.iteration, {
    error: 'plan receipt iteration must match its effect witness',
    path: ['effect', 'iteration'],
  });
export type V2PlanReceipt = z.infer<typeof trustedRunV2PlanReceiptSchema>;

export const trustedRunV2SynthesisReceiptSchema = z.strictObject({
  result_ref: opaqueRef('syn'),
  result_digest: sha256HexSchema,
  effect: trustedRunV2ProviderEffectWitnessSchema,
});
export type V2SynthesisReceipt = z.infer<typeof trustedRunV2SynthesisReceiptSchema>;

export const trustedRunV2EvidenceSchema = z
  .strictObject({
    prompt_digest: sha256DigestSchema.nullable(),
    source_count: z.int().nonnegative().max(32),
    source_taint: sourceTaintSchema,
    recall_status: z.enum(['partial', 'failed', 'skipped']).nullable(),
    tool_acl: z.array(toolNameSchema).max(toolNameSchema.options.length),
    provider_calls: z.int().nonnegative().max(16),
    total_tokens: z.int().nonnegative().max(100_000),
  })
  .refine((evidence) => new Set(evidence.tool_acl).size === evidence.tool_acl.length, {
    error: 'trusted V2 tool ACL must not contain duplicates',
    path: ['tool_acl'],
  });
export type V2RunEvidence = z.infer<typeof trustedRunV2EvidenceSchema>;

// This is the complete persisted V2 sidecar envelope. It has no V1 branch and no permissive
// normalisation: a malformed or mixed sidecar is rejected for the runtime to fail closed.
export const trustedRunV2StateSchema = z
  .strictObject({
    // A receipt-capable state is intentionally not a migration target for the earlier V2
    // envelope. Rows written before the reconcile-before-replay protocol fail closed instead of
    // being relabelled as if they had crossed this boundary.
    receipt_protocol: z.literal('reconciled_effects_v1'),
    canonical_identity_hash: sha256HexSchema,
    snapshot: trustedRunV2SnapshotSchema,
    record: runtimeInvocationV2RecordSchema,
    plan: trustedRunV2PlanReceiptSchema.nullable(),
    synthesis: trustedRunV2SynthesisReceiptSchema.nullable(),
    pending_effect: trustedRunV2PendingEffectSchema.nullable(),
    tool_effect_witnesses: z.array(trustedRunV2ToolEffectWitnessSchema).max(16),
    evidence: trustedRunV2EvidenceSchema,
  })
  .superRefine((state, context) => {
    if (state.plan !== null && state.synthesis !== null) {
      context.addIssue({
        code: 'custom',
        path: ['synthesis'],
        message: 'trusted V2 state cannot carry plan and terminal synthesis together',
      });
    }

    if (
      new Set(state.record.tool_checkpoints.map((checkpoint) => checkpoint.call_ref)).size !==
      state.record.tool_checkpoints.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['record', 'tool_checkpoints'],
        message: 'trusted V2 tool checkpoints must have unique call references',
      });
    }

    const settledToolCheckpoints: TrustedRunV2SettledToolCheckpoint[] =
      state.record.tool_checkpoints.filter(
      (
        checkpoint,
      ): checkpoint is TrustedRunV2SettledToolCheckpoint =>
        checkpoint.status === 'completed' ||
        (checkpoint.status === 'blocked' && checkpoint.effect_receipt !== undefined),
      );
    if (
      new Set(state.tool_effect_witnesses.map((witness) => witness.call_ref)).size !==
      state.tool_effect_witnesses.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['tool_effect_witnesses'],
        message: 'trusted tool effect witnesses must have unique call references',
      });
    }
    for (const checkpoint of settledToolCheckpoints) {
      if (!state.tool_effect_witnesses.some((witness) => witness.call_ref === checkpoint.call_ref)) {
        context.addIssue({
          code: 'custom',
          path: ['tool_effect_witnesses'],
          message: 'every settled trusted tool checkpoint requires one effect witness',
        });
      }
    }
    for (const witness of state.tool_effect_witnesses) {
      const checkpoint = state.record.tool_checkpoints.find(
        (candidate) => candidate.call_ref === witness.call_ref,
      );
      const completedWitness =
        checkpoint !== undefined &&
        checkpoint.status === 'completed' &&
        checkpoint.tool === witness.tool &&
        checkpoint.args_hash === witness.args_hash &&
        checkpoint.guards.argument_taint === witness.argument_taint;
      const rejectedWitness =
        checkpoint !== undefined &&
        checkpoint.status === 'blocked' &&
        checkpoint.tool === witness.tool &&
        checkpoint.effect_receipt !== undefined &&
        checkpoint.effect_receipt.args_hash === witness.args_hash &&
        checkpoint.effect_receipt.argument_taint === witness.argument_taint;
      if (!completedWitness && !rejectedWitness) {
        context.addIssue({
          code: 'custom',
          path: ['tool_effect_witnesses'],
          message: 'tool effect witness must bind a settled checkpoint identity',
        });
      }
    }

    const expectedAcl = TOOL_PERMISSIONS[state.record.invocation.runtime_binding.trigger];
    if (
      state.evidence.tool_acl.length !== expectedAcl.length ||
      state.evidence.tool_acl.some((tool, index) => tool !== expectedAcl[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evidence', 'tool_acl'],
        message: 'trusted V2 tool ACL must match the trusted trigger',
      });
    }

    if (state.record.context === null) {
      if (
        state.evidence.prompt_digest !== null ||
        state.evidence.source_count !== 0 ||
        state.evidence.source_taint !== null ||
        state.evidence.recall_status !== null ||
        state.record.tool_checkpoints.length !== 0 ||
        state.plan !== null ||
        state.synthesis !== null ||
        state.pending_effect !== null ||
        state.tool_effect_witnesses.length !== 0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['record'],
          message: 'trusted V2 state cannot carry execution facts before a context checkpoint',
        });
      }
    } else if (
      state.evidence.prompt_digest === null ||
      state.evidence.source_count !== state.record.context.sources.length ||
      state.evidence.source_taint !== state.record.context.source_taint ||
      state.evidence.recall_status === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'trusted V2 context evidence must bind its checkpoint',
      });
    }

    if (state.plan !== null) {
      if (state.plan.iteration !== state.evidence.provider_calls) {
        context.addIssue({
          code: 'custom',
          path: ['plan', 'iteration'],
          message: 'trusted V2 plan iteration must match provider evidence',
        });
      }
      if (
        (state.plan.iteration === 1 && state.plan.effect.kind !== 'provider_plan') ||
        (state.plan.iteration > 1 && state.plan.effect.kind !== 'provider_observe')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['plan', 'effect', 'kind'],
          message: 'trusted V2 plan receipt must bind its matching provider phase',
        });
      }
    }
    if (
      state.synthesis !== null &&
      (state.evidence.provider_calls === 0 ||
        state.synthesis.effect.kind !== 'provider_observe' ||
        state.synthesis.effect.iteration !== state.evidence.provider_calls)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['synthesis'],
        message: 'trusted V2 synthesis receipt must bind its provider evidence',
      });
    }

    // A pending intent represents the one external effect whose receipt is still in doubt. It
    // cannot coexist with a settled terminal provider receipt, nor can it masquerade as a retry
    // of a completed tool call. These constraints make the receipt boundary explicit in the
    // persisted contract, before the RunLoop may select an output or another tool branch.
    const pending = state.pending_effect;
    if (pending !== null) {
      if (state.synthesis !== null) {
        context.addIssue({
          code: 'custom',
          path: ['pending_effect'],
          message: 'trusted V2 synthesis receipt cannot coexist with an unresolved effect',
        });
      }
      if (pending.kind === 'tool') {
        if (state.plan === null) {
          context.addIssue({
            code: 'custom',
            path: ['pending_effect'],
            message: 'unresolved trusted tool effect requires its active plan receipt',
          });
        }
        if (
          state.record.tool_checkpoints.some(
            (checkpoint) => checkpoint.call_ref === pending.call_ref,
          ) ||
          state.tool_effect_witnesses.some((witness) => witness.call_ref === pending.call_ref)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['pending_effect', 'call_ref'],
            message: 'unresolved trusted tool effect cannot duplicate a settled tool call',
          });
        }
      } else {
        if (state.plan !== null) {
          context.addIssue({
            code: 'custom',
            path: ['pending_effect'],
            message: 'unresolved provider effect cannot coexist with an active plan receipt',
          });
        }
        if (pending.iteration !== state.evidence.provider_calls + 1) {
          context.addIssue({
            code: 'custom',
            path: ['pending_effect', 'iteration'],
            message: 'unresolved provider effect must be the next provider iteration',
          });
        }
        if (
          (pending.kind === 'provider_plan' && state.evidence.provider_calls !== 0) ||
          (pending.kind === 'provider_observe' && state.evidence.provider_calls === 0)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['pending_effect', 'kind'],
            message: 'unresolved provider effect must match its runtime phase',
          });
        }
      }
    }

    const effectWitnesses = [
      ...(state.plan === null ? [] : [state.plan.effect]),
      ...(state.synthesis === null ? [] : [state.synthesis.effect]),
      ...state.tool_effect_witnesses,
      ...(state.pending_effect === null ? [] : [state.pending_effect]),
    ];
    if (
      new Set(effectWitnesses.map((witness) => witness.effect_ref)).size !== effectWitnesses.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['pending_effect'],
        message: 'trusted V2 effect references must be unique',
      });
    }
    if (
      new Set(effectWitnesses.map((witness) => witness.idempotency_key)).size !==
      effectWitnesses.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['pending_effect'],
        message: 'trusted V2 effect idempotency keys must be unique',
      });
    }
  });
export type TrustedRunV2State = z.infer<typeof trustedRunV2StateSchema>;
