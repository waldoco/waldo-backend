// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  buildResponsibilityEffectV04Bundle,
  canonicalizeEffectIntentV04ForDigest,
  createResponsibilityEffectBindingVerifierV04,
  effectIntentV04Schema,
  effectReconciliationV04Schema,
  effectReceiptV04Schema,
  responsibilityEffectRejectionCatalogueV04Schema,
} from '../index';

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

const fixtureSchemas = {
  'effect-intent.schema.json': effectIntentV04Schema,
  'effect-receipt.schema.json': effectReceiptV04Schema,
  'effect-reconciliation.schema.json': effectReconciliationV04Schema,
} as const;

const validFixtureForSchema = {
  'effect-intent.schema.json': 'effect-intent.valid.json',
  'effect-receipt.schema.json': 'effect-receipt.valid.json',
  'effect-reconciliation.schema.json': 'effect-reconciliation-applied.valid.json',
} as const;

const REQUIRED_EFFECT_REJECTIONS_V04 = [
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
  'reconciliation-unknown-as-not-applied',
  'reconciliation-unknown-effect-retry',
  'reconciliation-provider-retry-owner',
  'reconciliation-third-effect-retry',
  'terminal-ambiguity-not-applied-basis',
  'reconciliation-owner-mismatch',
  'reconciliation-intent-digest-mismatch',
  'reconciliation-key-mismatch',
] as const;

function fixtureAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  for (const keyword of [
    'x-waldo-validation-level',
    'x-waldo-offline-commands',
  ]) ajv.addKeyword(keyword);
  return ajv;
}

function frozenIntent(overrides: Record<string, unknown> = {}) {
  const candidate = {
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
    ...overrides,
  };
  return effectIntentV04Schema.parse({
    ...candidate,
    intentDigest: `sha256:${sha256Hex(canonicalizeEffectIntentV04ForDigest(candidate))}`,
  });
}

describe('responsibility effect v0.4', () => {
  it('freezes one exact intent and converges only exact grant-use and reconciliation replay', () => {
    const verifier = createResponsibilityEffectBindingVerifierV04(sha256Hex);
    const intent = frozenIntent();

    expect(verifier.verifyIntent(intent)).toEqual(intent);
    expect(verifier.admitIntentReplay(intent, intent)).toEqual({
      disposition: 'exact_replay',
      intent,
    });

    const grantUseConflict = frozenIntent({
      id: 'effect_intent_fixture_02',
      argumentDigest: `sha256:${'5'.repeat(64)}`,
      reconciliationKey: 'effect_reconciliation_fixture_02',
    });
    expect(() => verifier.admitIntentReplay(intent, grantUseConflict)).toThrow(
      'grant/use binding already belongs to a different EffectIntent digest',
    );

    const reconciliationConflict = frozenIntent({
      id: 'effect_intent_fixture_03',
      authority: {
        ...intent.authority,
        grantId: 'authority_grant_fixture_02',
      },
      argumentDigest: `sha256:${'6'.repeat(64)}`,
    });
    expect(() => verifier.admitIntentReplay(intent, reconciliationConflict)).toThrow(
      'reconciliation key already belongs to a different EffectIntent digest',
    );

    for (const hostileField of [
      'credential',
      'oauthToken',
      'providerSecret',
      'mcpServer',
      'providerDone',
      'evidence',
      'verification',
      'acceptance',
      'closure',
    ]) {
      expect(effectIntentV04Schema.safeParse({
        ...intent,
        [hostileField]: 'attacker-controlled',
      }).success, hostileField).toBe(false);
    }
  });

  it('binds a bounded adapter receipt observation without promoting it to product truth', () => {
    const verifier = createResponsibilityEffectBindingVerifierV04(sha256Hex);
    const intent = frozenIntent();
    const receipt = {
      protocolVersion: '0.4',
      id: 'effect_receipt_fixture_01',
      ownerId: intent.ownerId,
      intentId: intent.id,
      intentDigest: intent.intentDigest,
      reconciliationKey: intent.reconciliationKey,
      adapter: intent.adapter,
      attempt: 1,
      adapterOutcome: 'reported_applied',
      externalEffectRef: 'external_effect_fixture_01',
      observation: {
        ref: 'adapter_observation_fixture_01',
        digest: `sha256:${'7'.repeat(64)}`,
      },
      issuedAt: '2026-08-08T18:11:01.000Z',
      observedAt: '2026-08-08T18:11:02.000Z',
      state: 'observed',
    } as const;

    expect(effectReceiptV04Schema.parse(receipt)).toEqual(receipt);
    expect(verifier.verifyReceiptBinding(intent, receipt)).toEqual(receipt);

    for (const [name, mutation, message] of [
      [
        'owner',
        { ownerId: 'owner_other' },
        'EffectReceipt owner must match its EffectIntent',
      ],
      [
        'intent digest',
        { intentDigest: `sha256:${'8'.repeat(64)}` },
        'EffectReceipt must bind the exact EffectIntent digest',
      ],
      [
        'reconciliation key',
        { reconciliationKey: 'effect_reconciliation_other' },
        'EffectReceipt reconciliation key must match its EffectIntent',
      ],
      [
        'issued before frozen intent',
        { issuedAt: '2026-08-08T18:10:59.999Z' },
        'EffectReceipt issue must occur after intent freeze and before expiry',
      ],
    ] as const) {
      expect(
        () => verifier.verifyReceiptBinding(intent, { ...receipt, ...mutation }),
        name,
      ).toThrow(message);
    }

    for (const hostileField of [
      'rawResponse',
      'credential',
      'providerDone',
      'evidence',
      'verification',
      'acceptance',
      'closure',
    ]) {
      expect(effectReceiptV04Schema.safeParse({
        ...receipt,
        [hostileField]: 'attacker-controlled',
      }).success, hostileField).toBe(false);
    }
  });

  it('keeps issue, read-back, retry, and terminal ambiguity reconciliation distinct', () => {
    const verifier = createResponsibilityEffectBindingVerifierV04(sha256Hex);
    const intent = frozenIntent();
    const common = {
      protocolVersion: '0.4',
      ownerId: intent.ownerId,
      intentId: intent.id,
      intentDigest: intent.intentDigest,
      reconciliationKey: intent.reconciliationKey,
      revision: 1,
      checkedAt: '2026-08-08T18:11:03.000Z',
    } as const;
    const observation = {
      ref: 'reconciliation_observation_fixture_01',
      digest: `sha256:${'9'.repeat(64)}`,
    } as const;
    const states = [
      {
        ...common,
        id: 'effect_reconciliation_issue_fixture_01',
        state: 'issue',
        attempt: 1,
        basis: 'no_prior_issue',
      },
      {
        ...common,
        id: 'effect_reconciliation_not_applied_fixture_01',
        state: 'authoritative_not_applied',
        attempt: 1,
        receiptId: 'effect_receipt_fixture_01',
        observation: { ...observation, kind: 'authoritative_read_back' },
      },
      {
        ...common,
        id: 'effect_reconciliation_applied_fixture_01',
        state: 'applied',
        attempt: 1,
        receiptId: 'effect_receipt_fixture_01',
        externalEffectRef: 'external_effect_fixture_01',
        observation: { ...observation, kind: 'applied_found' },
      },
      {
        ...common,
        id: 'effect_reconciliation_unavailable_fixture_01',
        state: 'unavailable',
        attempt: 1,
        receiptId: 'effect_receipt_fixture_01',
        observation: { ...observation, kind: 'read_back_unavailable' },
      },
      {
        ...common,
        id: 'effect_reconciliation_unknown_fixture_01',
        state: 'unknown',
        attempt: 1,
        receiptId: 'effect_receipt_fixture_01',
        observation: { ...observation, kind: 'application_unknown' },
      },
      {
        ...common,
        id: 'effect_reconciliation_retry_fixture_01',
        state: 'retry_admitted',
        attempt: 1,
        basis: {
          kind: 'authoritative_not_applied',
          reconciliationId: 'effect_reconciliation_not_applied_fixture_01',
          digest: `sha256:${'a'.repeat(64)}`,
        },
        retryOwner: 'effect_engine',
        nextAttempt: 2,
        remainingAttempts: 0,
      },
      {
        ...common,
        id: 'effect_reconciliation_ambiguity_fixture_01',
        state: 'terminal_ambiguity',
        attempt: 2,
        basis: {
          kind: 'unknown',
          reconciliationId: 'effect_reconciliation_unknown_fixture_01',
          digest: `sha256:${'b'.repeat(64)}`,
        },
      },
    ] as const;

    for (const state of states) {
      expect(effectReconciliationV04Schema.parse(state), state.state).toEqual(state);
      expect(verifier.verifyReconciliationBinding(intent, state)).toEqual(state);
    }

    const retry = states[5];
    expect(effectReconciliationV04Schema.safeParse({
      ...retry,
      basis: { ...retry.basis, kind: 'unknown' },
    }).success).toBe(false);

    const unknown = states[4];
    expect(effectReconciliationV04Schema.safeParse({
      ...unknown,
      state: 'authoritative_not_applied',
    }).success).toBe(false);

    for (const hostileField of [
      'providerRetry',
      'providerDone',
      'artifact',
      'evidence',
      'verification',
      'acceptance',
      'closure',
    ]) {
      expect(effectReconciliationV04Schema.safeParse({
        ...states[6],
        [hostileField]: 'attacker-controlled',
      }).success, hostileField).toBe(false);
    }
  });

  it('publishes Draft 2020-12 schemas that round-trip every effect fixture family', () => {
    const bundle = buildResponsibilityEffectV04Bundle(sha256Hex);

    for (const [schemaPath, zodSchema] of Object.entries(fixtureSchemas)) {
      const fixturePath = validFixtureForSchema[schemaPath as keyof typeof validFixtureForSchema];
      const valid = JSON.parse(bundle[fixturePath]!);
      expect(zodSchema.parse(valid)).toEqual(valid);

      const jsonSchema = JSON.parse(bundle[schemaPath]!);
      expect(jsonSchema).toMatchObject({
        'x-waldo-validation-level': 'structural-plus-runtime-invariants',
        'x-waldo-offline-commands': 'none',
      });
      const validate = fixtureAjv().compile(jsonSchema);
      expect(validate(valid), `${schemaPath}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }

    for (const fixturePath of [
      'effect-reconciliation-issue.valid.json',
      'effect-reconciliation-not-applied.valid.json',
      'effect-reconciliation-applied.valid.json',
      'effect-reconciliation-unavailable.valid.json',
      'effect-reconciliation-unknown.valid.json',
      'effect-reconciliation-retry.valid.json',
      'effect-reconciliation-terminal-ambiguity.valid.json',
    ]) {
      expect(effectReconciliationV04Schema.parse(JSON.parse(bundle[fixturePath]!))).toBeDefined();
    }
  });

  it('asserts every effect rejection at its declared validation layer', () => {
    const bundle = buildResponsibilityEffectV04Bundle(sha256Hex);
    const catalogue = responsibilityEffectRejectionCatalogueV04Schema.parse(
      JSON.parse(bundle['responsibility-effect.rejections.json']!),
    );
    const validators = Object.fromEntries(
      Object.keys(fixtureSchemas).map((schemaPath) => [
        schemaPath,
        fixtureAjv().compile(JSON.parse(bundle[schemaPath]!)),
      ]),
    );
    const intent = effectIntentV04Schema.parse(JSON.parse(bundle['effect-intent.valid.json']!));
    const verifier = createResponsibilityEffectBindingVerifierV04(sha256Hex);

    expect(catalogue.cases.map((entry) => entry.name)).toEqual([
      ...REQUIRED_EFFECT_REJECTIONS_V04,
    ]);
    expect(new Set(catalogue.cases.map((entry) => entry.name)).size).toBe(
      catalogue.cases.length,
    );

    for (const rejection of catalogue.cases) {
      const validate = validators[rejection.schema]!;
      expect(
        validate(rejection.value),
        `${rejection.name}: ${JSON.stringify(validate.errors)}`,
      ).toBe(rejection.layer !== 'schema');
      expect(
        fixtureSchemas[rejection.schema].safeParse(rejection.value).success,
        rejection.name,
      ).toBe(rejection.zodOutcome === 'accept');

      if (rejection.layer !== 'binding') continue;
      if (rejection.schema === 'effect-intent.schema.json') {
        expect(() => verifier.verifyIntent(rejection.value), rejection.name).toThrow();
      } else if (rejection.schema === 'effect-receipt.schema.json') {
        expect(
          () => verifier.verifyReceiptBinding(intent, rejection.value),
          rejection.name,
        ).toThrow();
      } else {
        expect(
          () => verifier.verifyReconciliationBinding(intent, rejection.value),
          rejection.name,
        ).toThrow();
      }
    }
  });

  it('pins every effect fixture byte in an adapter-conformance manifest', () => {
    const bundle = buildResponsibilityEffectV04Bundle((value) =>
      value.length.toString(16).padStart(64, '0'));
    const manifest = JSON.parse(bundle['manifest.json']!);

    expect(manifest).toMatchObject({
      protocolName: 'responsibility-effect',
      protocolVersion: '0.4',
      offlineCommands: 'none',
      proofLevel: 'adapter_conformance_fixture',
    });
    expect(manifest.files).toEqual(
      Object.keys(bundle)
        .filter((path) => path !== 'manifest.json')
        .sort()
        .map((path) => ({
          path,
          sha256: `sha256:${bundle[path]!.length.toString(16).padStart(64, '0')}`,
        })),
    );
  });
});
