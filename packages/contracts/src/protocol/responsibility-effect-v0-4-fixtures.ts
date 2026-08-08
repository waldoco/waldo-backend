import { z } from 'zod';
import { protocolVersionV04Schema } from './responsibility-acceptance-check-v0-4';
import {
  canonicalizeEffectIntentV04ForDigest,
  canonicalizeEffectReconciliationV04ForDigest,
  effectIntentV04Schema,
  effectReceiptV04Schema,
  effectReconciliationV04Schema,
} from './responsibility-effect-v0-4';

type HashHex = (input: string) => string;
const file = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const schema = (value: z.ZodType, name: string) => ({
  ...(z.toJSONSchema(value, { target: 'draft-2020-12', io: 'input', reused: 'ref' }) as object),
  $id: `urn:waldo:protocol:responsibility-effect:0.4:${name}`,
  'x-waldo-validation-level': 'structural-plus-runtime-invariants',
  'x-waldo-offline-commands': 'none',
});

export const RESPONSIBILITY_EFFECT_REJECTION_NAMES_V04 = [
  'intent-credential-field',
  'intent-oauth-token-field',
  'intent-mcp-field',
  'intent-provider-done-field',
  'intent-evidence-field',
  'intent-acceptance-field',
  'intent-closure-field',
  'intent-invalid-revision',
  'intent-invalid-use-index',
  'intent-non-frozen-state',
  'intent-expiry-before-freeze',
  'intent-malformed-argument-digest',
  'intent-lone-surrogate-id',
  'intent-id-byte-ceiling',
  'intent-digest-mismatch',
  'receipt-raw-response-field',
  'receipt-provider-done-field',
  'receipt-artifact-field',
  'receipt-acceptance-field',
  'receipt-third-attempt',
  'receipt-applied-without-external-ref',
  'receipt-observation-before-issue',
  'receipt-issued-before-frozen-intent',
  'receipt-owner-mismatch',
  'receipt-intent-digest-mismatch',
  'receipt-reconciliation-key-mismatch',
  'receipt-adapter-mismatch',
  'reconciliation-provider-retry-field',
  'reconciliation-provider-done-field',
  'reconciliation-artifact-field',
  'reconciliation-acceptance-field',
  'reconciliation-unavailable-as-not-applied',
  'reconciliation-retry-unavailable-basis-kind',
  'reconciliation-unavailable-as-retry',
  'reconciliation-unknown-as-not-applied',
  'reconciliation-unknown-effect-retry',
  'reconciliation-provider-retry-owner',
  'reconciliation-third-effect-retry',
  'terminal-ambiguity-not-applied-basis',
  'terminal-ambiguity-wrong-referenced-state',
  'reconciliation-owner-mismatch',
  'reconciliation-intent-digest-mismatch',
  'reconciliation-key-mismatch',
] as const;

const responsibilityEffectRejectionCasesV04Schema = z.array(z.strictObject({
  name: z.enum(RESPONSIBILITY_EFFECT_REJECTION_NAMES_V04),
  schema: z.enum([
    'effect-intent.schema.json',
    'effect-receipt.schema.json',
    'effect-reconciliation.schema.json',
  ]),
  layer: z.enum(['schema', 'runtime', 'binding']),
  zodOutcome: z.enum(['accept', 'reject']),
  value: z.unknown(),
  referenced: z.unknown().optional(),
})).length(RESPONSIBILITY_EFFECT_REJECTION_NAMES_V04.length)
  .superRefine((cases, context) => {
    const names = cases.map((entry) => entry.name);
    for (const [index, expected] of RESPONSIBILITY_EFFECT_REJECTION_NAMES_V04.entries()) {
      if (names[index] !== expected) {
        context.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: `rejection case ${index + 1} must be ${expected}`,
        });
      }
    }
  });

export const responsibilityEffectRejectionCatalogueV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  cases: responsibilityEffectRejectionCasesV04Schema,
});

export function buildResponsibilityEffectV04Bundle(hashHex: HashHex): Record<string, string> {
  const intentCandidate = {
    protocolVersion: '0.4',
    id: 'effect_intent_fixture_01',
    ownerId: 'owner_fixture_01',
    revision: 1,
    outcome: { id: 'outcome_fixture_01', revision: 3 },
    workUnit: { id: 'work_unit_fixture_01', revision: 4 },
    judgment: {
      requestId: 'judgment_request_fixture_01',
      requestRevision: 2,
      decisionId: 'judgment_decision_fixture_01',
      decisionRevision: 1,
    },
    authority: {
      grantId: 'authority_grant_fixture_01',
      grantRevision: 1,
      useIndex: 1,
      revocationGeneration: 0,
    },
    purpose: 'calendar.follow_up.schedule',
    effectFamily: 'calendar.event.create',
    argumentDigest: `sha256:${'1'.repeat(64)}`,
    contextDigest: `sha256:${'2'.repeat(64)}`,
    artifactDigest: null,
    capability: {
      id: 'capability_calendar_event_create_fixture_01',
      version: '1.0.0',
      manifestDigest: `sha256:${'3'.repeat(64)}`,
      eligibilityRevision: 1,
    },
    adapter: {
      id: 'effect_adapter_fixture_01',
      version: '1.0.0',
      manifestDigest: `sha256:${'4'.repeat(64)}`,
    },
    reconciliationKey: 'effect_reconciliation_fixture_01',
    lease: { id: 'execution_lease_fixture_01', fencingGeneration: 1 },
    cancellationGeneration: 0,
    expiresAt: '2026-08-08T18:30:00.000Z',
    frozenAt: '2026-08-08T18:11:00.000Z',
    state: 'frozen',
    intentDigest: `sha256:${'0'.repeat(64)}`,
  } as const;
  const effectIntent = effectIntentV04Schema.parse({
    ...intentCandidate,
    intentDigest: `sha256:${hashHex(canonicalizeEffectIntentV04ForDigest(intentCandidate))}`,
  });

  const effectReceipt = effectReceiptV04Schema.parse({
    protocolVersion: '0.4',
    id: 'effect_receipt_fixture_01',
    ownerId: effectIntent.ownerId,
    intentId: effectIntent.id,
    intentDigest: effectIntent.intentDigest,
    reconciliationKey: effectIntent.reconciliationKey,
    adapter: effectIntent.adapter,
    attempt: 1,
    adapterOutcome: 'reported_applied',
    externalEffectRef: 'external_effect_fixture_01',
    observation: {
      ref: 'adapter_observation_fixture_01',
      digest: `sha256:${'5'.repeat(64)}`,
    },
    issuedAt: '2026-08-08T18:11:01.000Z',
    observedAt: '2026-08-08T18:11:02.000Z',
    state: 'observed',
  });

  const reconciliationCommon = {
    protocolVersion: '0.4',
    ownerId: effectIntent.ownerId,
    intentId: effectIntent.id,
    intentDigest: effectIntent.intentDigest,
    reconciliationKey: effectIntent.reconciliationKey,
    revision: 1,
    checkedAt: '2026-08-08T18:11:03.000Z',
  } as const;
  const observation = {
    ref: 'reconciliation_observation_fixture_01',
    digest: `sha256:${'6'.repeat(64)}`,
  } as const;
  const issue = effectReconciliationV04Schema.parse({
    ...reconciliationCommon,
    id: 'effect_reconciliation_issue_fixture_01',
    state: 'issue',
    attempt: 1,
    basis: 'no_prior_issue',
  });
  const notApplied = effectReconciliationV04Schema.parse({
    ...reconciliationCommon,
    id: 'effect_reconciliation_not_applied_fixture_01',
    state: 'authoritative_not_applied',
    attempt: 1,
    receiptId: effectReceipt.id,
    observation: { ...observation, kind: 'authoritative_read_back' },
  });
  const applied = effectReconciliationV04Schema.parse({
    ...reconciliationCommon,
    id: 'effect_reconciliation_applied_fixture_01',
    state: 'applied',
    attempt: 1,
    receiptId: effectReceipt.id,
    externalEffectRef: 'external_effect_fixture_01',
    observation: { ...observation, kind: 'applied_found' },
  });
  const unavailable = effectReconciliationV04Schema.parse({
    ...reconciliationCommon,
    id: 'effect_reconciliation_unavailable_fixture_01',
    state: 'unavailable',
    attempt: 1,
    receiptId: effectReceipt.id,
    observation: { ...observation, kind: 'read_back_unavailable' },
  });
  const unknown = effectReconciliationV04Schema.parse({
    ...reconciliationCommon,
    id: 'effect_reconciliation_unknown_fixture_01',
    state: 'unknown',
    attempt: 1,
    receiptId: effectReceipt.id,
    observation: { ...observation, kind: 'application_unknown' },
  });
  const retry = effectReconciliationV04Schema.parse({
    ...reconciliationCommon,
    id: 'effect_reconciliation_retry_fixture_01',
    state: 'retry_admitted',
    attempt: 1,
    basis: {
      kind: 'authoritative_not_applied',
      reconciliationId: notApplied.id,
      digest: `sha256:${hashHex(canonicalizeEffectReconciliationV04ForDigest(notApplied))}`,
    },
    retryOwner: 'effect_engine',
    nextAttempt: 2,
    remainingAttempts: 0,
  });
  const terminalAmbiguity = effectReconciliationV04Schema.parse({
    ...reconciliationCommon,
    id: 'effect_reconciliation_terminal_ambiguity_fixture_01',
    state: 'terminal_ambiguity',
    attempt: 2,
    basis: {
      kind: 'unknown',
      reconciliationId: unknown.id,
      digest: `sha256:${hashHex(canonicalizeEffectReconciliationV04ForDigest(unknown))}`,
    },
  });
  if (retry.state !== 'retry_admitted' || terminalAmbiguity.state !== 'terminal_ambiguity') {
    throw new Error('effect reconciliation fixtures must retain their declared states');
  }

  const schemas = {
    'effect-intent.schema.json': schema(effectIntentV04Schema, 'effect-intent'),
    'effect-receipt.schema.json': schema(effectReceiptV04Schema, 'effect-receipt'),
    'effect-reconciliation.schema.json': schema(
      effectReconciliationV04Schema,
      'effect-reconciliation',
    ),
  };
  const files: Record<string, string> = {
    ...Object.fromEntries(Object.entries(schemas).map(([path, value]) => [path, file(value)])),
    'effect-intent.valid.json': file(effectIntent),
    'effect-receipt.valid.json': file(effectReceipt),
    'effect-reconciliation-issue.valid.json': file(issue),
    'effect-reconciliation-not-applied.valid.json': file(notApplied),
    'effect-reconciliation-applied.valid.json': file(applied),
    'effect-reconciliation-unavailable.valid.json': file(unavailable),
    'effect-reconciliation-unknown.valid.json': file(unknown),
    'effect-reconciliation-retry.valid.json': file(retry),
    'effect-reconciliation-terminal-ambiguity.valid.json': file(terminalAmbiguity),
    'responsibility-effect.rejections.json': file(
      responsibilityEffectRejectionCatalogueV04Schema.parse({
        protocolVersion: '0.4',
        cases: [
          { name: 'intent-credential-field', schema: 'effect-intent.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectIntent, credential: 'secret' } },
          { name: 'intent-oauth-token-field', schema: 'effect-intent.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectIntent, oauthToken: 'secret' } },
          { name: 'intent-mcp-field', schema: 'effect-intent.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectIntent, mcpServer: 'ambient' } },
          { name: 'intent-provider-done-field', schema: 'effect-intent.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectIntent, providerDone: true } },
          { name: 'intent-evidence-field', schema: 'effect-intent.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectIntent, evidence: { id: 'evidence_attacker' } } },
          { name: 'intent-acceptance-field', schema: 'effect-intent.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectIntent, acceptance: 'accepted' } },
          { name: 'intent-closure-field', schema: 'effect-intent.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectIntent, closure: 'closed' } },
          { name: 'intent-invalid-revision', schema: 'effect-intent.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectIntent, revision: 2 } },
          { name: 'intent-invalid-use-index', schema: 'effect-intent.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectIntent, authority: { ...effectIntent.authority, useIndex: 2 } } },
          { name: 'intent-non-frozen-state', schema: 'effect-intent.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectIntent, state: 'issued' } },
          { name: 'intent-expiry-before-freeze', schema: 'effect-intent.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...effectIntent, expiresAt: effectIntent.frozenAt } },
          { name: 'intent-malformed-argument-digest', schema: 'effect-intent.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectIntent, argumentDigest: 'sha256:not-a-digest' } },
          { name: 'intent-lone-surrogate-id', schema: 'effect-intent.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectIntent, id: '\ud800' } },
          { name: 'intent-id-byte-ceiling', schema: 'effect-intent.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectIntent, id: `effect_${'a'.repeat(128)}` } },
          { name: 'intent-digest-mismatch', schema: 'effect-intent.schema.json', layer: 'binding', zodOutcome: 'accept', value: { ...effectIntent, intentDigest: `sha256:${'f'.repeat(64)}` } },
          { name: 'receipt-raw-response-field', schema: 'effect-receipt.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectReceipt, rawResponse: { private: true } } },
          { name: 'receipt-provider-done-field', schema: 'effect-receipt.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectReceipt, providerDone: true } },
          { name: 'receipt-artifact-field', schema: 'effect-receipt.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectReceipt, artifact: { id: 'artifact_attacker' } } },
          { name: 'receipt-acceptance-field', schema: 'effect-receipt.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectReceipt, acceptance: 'accepted' } },
          { name: 'receipt-third-attempt', schema: 'effect-receipt.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...effectReceipt, attempt: 3 } },
          { name: 'receipt-applied-without-external-ref', schema: 'effect-receipt.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...effectReceipt, externalEffectRef: null } },
          { name: 'receipt-observation-before-issue', schema: 'effect-receipt.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...effectReceipt, observedAt: '2026-08-08T18:11:00.999Z' } },
          { name: 'receipt-issued-before-frozen-intent', schema: 'effect-receipt.schema.json', layer: 'binding', zodOutcome: 'accept', value: { ...effectReceipt, issuedAt: '2026-08-08T18:10:59.999Z' } },
          { name: 'receipt-owner-mismatch', schema: 'effect-receipt.schema.json', layer: 'binding', zodOutcome: 'accept', value: { ...effectReceipt, ownerId: 'owner_other' } },
          { name: 'receipt-intent-digest-mismatch', schema: 'effect-receipt.schema.json', layer: 'binding', zodOutcome: 'accept', value: { ...effectReceipt, intentDigest: `sha256:${'a'.repeat(64)}` } },
          { name: 'receipt-reconciliation-key-mismatch', schema: 'effect-receipt.schema.json', layer: 'binding', zodOutcome: 'accept', value: { ...effectReceipt, reconciliationKey: 'effect_reconciliation_other' } },
          { name: 'receipt-adapter-mismatch', schema: 'effect-receipt.schema.json', layer: 'binding', zodOutcome: 'accept', value: { ...effectReceipt, adapter: { ...effectReceipt.adapter, id: 'effect_adapter_other' } } },
          { name: 'reconciliation-provider-retry-field', schema: 'effect-reconciliation.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...terminalAmbiguity, providerRetry: true } },
          { name: 'reconciliation-provider-done-field', schema: 'effect-reconciliation.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...applied, providerDone: true } },
          { name: 'reconciliation-artifact-field', schema: 'effect-reconciliation.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...applied, artifact: { id: 'artifact_attacker' } } },
          { name: 'reconciliation-acceptance-field', schema: 'effect-reconciliation.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...applied, acceptance: 'accepted' } },
          { name: 'reconciliation-unavailable-as-not-applied', schema: 'effect-reconciliation.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...unavailable, state: 'authoritative_not_applied' } },
          { name: 'reconciliation-retry-unavailable-basis-kind', schema: 'effect-reconciliation.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...retry, basis: { ...retry.basis, kind: 'unavailable' } } },
          {
            name: 'reconciliation-unavailable-as-retry',
            schema: 'effect-reconciliation.schema.json',
            layer: 'binding',
            zodOutcome: 'accept',
            value: {
              ...retry,
              basis: {
                ...retry.basis,
                reconciliationId: unavailable.id,
                digest: `sha256:${hashHex(
                  canonicalizeEffectReconciliationV04ForDigest(unavailable),
                )}`,
              },
            },
            referenced: unavailable,
          },
          { name: 'reconciliation-unknown-as-not-applied', schema: 'effect-reconciliation.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...unknown, state: 'authoritative_not_applied' } },
          { name: 'reconciliation-unknown-effect-retry', schema: 'effect-reconciliation.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...retry, basis: { ...retry.basis, kind: 'unknown' } } },
          { name: 'reconciliation-provider-retry-owner', schema: 'effect-reconciliation.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...retry, retryOwner: 'provider' } },
          { name: 'reconciliation-third-effect-retry', schema: 'effect-reconciliation.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...retry, nextAttempt: 3 } },
          { name: 'terminal-ambiguity-not-applied-basis', schema: 'effect-reconciliation.schema.json', layer: 'schema', zodOutcome: 'reject', value: { ...terminalAmbiguity, basis: { ...terminalAmbiguity.basis, kind: 'authoritative_not_applied' } } },
          {
            name: 'terminal-ambiguity-wrong-referenced-state',
            schema: 'effect-reconciliation.schema.json',
            layer: 'binding',
            zodOutcome: 'accept',
            value: {
              ...terminalAmbiguity,
              basis: {
                ...terminalAmbiguity.basis,
                reconciliationId: unavailable.id,
                digest: `sha256:${hashHex(
                  canonicalizeEffectReconciliationV04ForDigest(unavailable),
                )}`,
              },
            },
            referenced: unavailable,
          },
          { name: 'reconciliation-owner-mismatch', schema: 'effect-reconciliation.schema.json', layer: 'binding', zodOutcome: 'accept', value: { ...applied, ownerId: 'owner_other' } },
          { name: 'reconciliation-intent-digest-mismatch', schema: 'effect-reconciliation.schema.json', layer: 'binding', zodOutcome: 'accept', value: { ...applied, intentDigest: `sha256:${'b'.repeat(64)}` } },
          { name: 'reconciliation-key-mismatch', schema: 'effect-reconciliation.schema.json', layer: 'binding', zodOutcome: 'accept', value: { ...applied, reconciliationKey: 'effect_reconciliation_other' } },
        ],
      }),
    ),
  };

  return {
    ...files,
    'manifest.json': file({
      protocolName: 'responsibility-effect',
      protocolVersion: '0.4',
      mediaType: 'application/vnd.waldo.responsibility.v0.4+json',
      offlineCommands: 'none',
      proofLevel: 'adapter_conformance_fixture',
      files: Object.keys(files).sort().map((path) => ({
        path,
        sha256: `sha256:${hashHex(files[path]!)}`,
      })),
    }),
  };
}
