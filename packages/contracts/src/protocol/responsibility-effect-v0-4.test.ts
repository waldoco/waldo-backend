// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  buildResponsibilityEffectV04Bundle,
  canonicalizeEffectIntentV04ForDigest,
  canonicalizeEffectReconciliationV04ForDigest,
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

function consequentialIntentMutations(intent: ReturnType<typeof frozenIntent>) {
  return [
    ['id', frozenIntent({ id: 'effect_intent_fixture_02' })],
    ['ownerId', frozenIntent({ ownerId: 'owner_fixture_02' })],
    ['outcome.id', frozenIntent({ outcome: { ...intent.outcome, id: 'outcome_fixture_02' } })],
    ['outcome.revision', frozenIntent({ outcome: { ...intent.outcome, revision: 4 } })],
    ['workUnit.id', frozenIntent({ workUnit: { ...intent.workUnit, id: 'work_unit_fixture_02' } })],
    ['workUnit.revision', frozenIntent({ workUnit: { ...intent.workUnit, revision: 5 } })],
    ['judgment.requestId', frozenIntent({ judgment: { ...intent.judgment, requestId: 'judgment_request_fixture_02' } })],
    ['judgment.requestRevision', frozenIntent({ judgment: { ...intent.judgment, requestRevision: 3 } })],
    ['judgment.decisionId', frozenIntent({ judgment: { ...intent.judgment, decisionId: 'judgment_decision_fixture_02' } })],
    ['judgment.decisionRevision', frozenIntent({ judgment: { ...intent.judgment, decisionRevision: 2 } })],
    ['authority.grantId', frozenIntent({ authority: { ...intent.authority, grantId: 'authority_grant_fixture_02' } })],
    ['authority.grantRevision', frozenIntent({ authority: { ...intent.authority, grantRevision: 2 } })],
    ['authority.revocationGeneration', frozenIntent({ authority: { ...intent.authority, revocationGeneration: 1 } })],
    ['purpose', frozenIntent({ purpose: 'calendar.follow_up.reschedule' })],
    ['effectFamily', frozenIntent({ effectFamily: 'calendar.event.update' })],
    ['argumentDigest', frozenIntent({ argumentDigest: `sha256:${'a'.repeat(64)}` })],
    ['contextDigest', frozenIntent({ contextDigest: `sha256:${'b'.repeat(64)}` })],
    ['artifactDigest', frozenIntent({ artifactDigest: `sha256:${'c'.repeat(64)}` })],
    ['capability.id', frozenIntent({ capability: { ...intent.capability, id: 'capability_calendar_event_create_fixture_02' } })],
    ['capability.version', frozenIntent({ capability: { ...intent.capability, version: '1.0.1' } })],
    ['capability.manifestDigest', frozenIntent({ capability: { ...intent.capability, manifestDigest: `sha256:${'d'.repeat(64)}` } })],
    ['capability.eligibilityRevision', frozenIntent({ capability: { ...intent.capability, eligibilityRevision: 2 } })],
    ['adapter.id', frozenIntent({ adapter: { ...intent.adapter, id: 'effect_adapter_fixture_02' } })],
    ['adapter.version', frozenIntent({ adapter: { ...intent.adapter, version: '1.0.1' } })],
    ['adapter.manifestDigest', frozenIntent({ adapter: { ...intent.adapter, manifestDigest: `sha256:${'e'.repeat(64)}` } })],
    ['reconciliationKey', frozenIntent({ reconciliationKey: 'effect_reconciliation_fixture_02' })],
    ['lease.id', frozenIntent({ lease: { ...intent.lease, id: 'execution_lease_fixture_02' } })],
    ['lease.fencingGeneration', frozenIntent({ lease: { ...intent.lease, fencingGeneration: 2 } })],
    ['cancellationGeneration', frozenIntent({ cancellationGeneration: 1 })],
    ['expiresAt', frozenIntent({ expiresAt: '2026-08-08T18:29:59.999Z' })],
    ['frozenAt', frozenIntent({ frozenAt: '2026-08-08T18:11:00.001Z' })],
  ] as const;
}

describe('responsibility effect v0.4', () => {
  it('pins independent canonical digests for every mutable consequential intent field', () => {
    const intent = frozenIntent();
    expect(consequentialIntentMutations(intent).map(([field, value]) => [
      field,
      `sha256:${sha256Hex(canonicalizeEffectIntentV04ForDigest(value))}`,
    ])).toEqual([
      ['id', 'sha256:56b731162e7565127a38e736fc08cbb70a4da24988bc54b83dca289ff86ae12f'],
      ['ownerId', 'sha256:de1cc9baeefb3bd2e465ee436abff3a80b052f7906813d6bcc10fd4d31500d58'],
      ['outcome.id', 'sha256:6e33ccf617390c1f349447718a100e5dcbd6003f914798b9ca67982c00b4d98c'],
      ['outcome.revision', 'sha256:7811c20e2140c3c19c56ac45b07f7df53dab2b7ab9f51b2fb421a5c7cc8c0259'],
      ['workUnit.id', 'sha256:eda683cb50d1ec1a65059b4fdd0b984bbece6ec224f00823f022ff1e510d6251'],
      ['workUnit.revision', 'sha256:7797325261d32f52d95cd79be5a2f7b7f5599394cfc2fd410843ccf104bdc3a8'],
      ['judgment.requestId', 'sha256:c3f966f3a1ef4523a3a2ed009556a4bdb87fd2b3fdb65f0de1a875f1397bb4a8'],
      ['judgment.requestRevision', 'sha256:f0deeb13eb164f3c1ff8286e19b62fd8d7d64a5358f5b2a5ac759accdd60349b'],
      ['judgment.decisionId', 'sha256:b8d4b9e7a31b2c36689b81b675a857c46f74d86e0f4ac3c9b91a9b9e718295b4'],
      ['judgment.decisionRevision', 'sha256:4092f6381b5aeb291049c63806e64928e7d79caf1ec8bfa8de4a95433576fbe1'],
      ['authority.grantId', 'sha256:88b392d79679eb8385168b436491da38768badbdd60dbe7cfde89fbdbd056300'],
      ['authority.grantRevision', 'sha256:1d3bb9c413b50081f116c2a5be9dbf975b9307a2968e9560e502b9cf32b71862'],
      ['authority.revocationGeneration', 'sha256:697073e79ceafc3563d72ac08a13985cfd4149d3a5a2b815c1183fd6559697a5'],
      ['purpose', 'sha256:dfeb98ea02a437b95e4e9707a4a645fa5224341ad9c28877d7ec6a0a128745e3'],
      ['effectFamily', 'sha256:e686b8573360a7fb0f6a3aeae1cb7cb9b7a3aba3f5118fa5a565b983f52e48d6'],
      ['argumentDigest', 'sha256:bdc60fd705d9f41dac0460b12b63873a40449ef1665d17a5055aed44c39ed8d1'],
      ['contextDigest', 'sha256:dcc6c9b3ca6ff6f88d75e4f334eca49a7bfe9b3c18b965d7a5ef6d3f12953abf'],
      ['artifactDigest', 'sha256:7cdc394845afd3d799ebfbd69219fe8a55190dfa93050d25a343750e32059bba'],
      ['capability.id', 'sha256:83af88a6ae238841454865a1ca774b2885e9844031fab6e1687af5d0c7fdad58'],
      ['capability.version', 'sha256:11ab3caa5cc0e84b2fc88d88528ba62b3a05bf73c0577df5ef661167cfd22b5a'],
      ['capability.manifestDigest', 'sha256:ea57dff08505bcf6241e058c8f7bf69fd54607c749fa553c571db6ec0a6cdbb4'],
      ['capability.eligibilityRevision', 'sha256:c252249a3fe53ebfbf01a359231bd06a05b38fefcde80b96a30a8527650ef0eb'],
      ['adapter.id', 'sha256:947d5aecdee3a1f73c7861ff824fa0debea89f7910456c4e70d67cd359ef93a2'],
      ['adapter.version', 'sha256:96cf9bd04f697af0f91dcd2787716572d1272996076e567ef09db9c8cce8abdd'],
      ['adapter.manifestDigest', 'sha256:af4cf472d8fbbed91382c3585bbd853d23379c2903dadc152e106794518b9dd4'],
      ['reconciliationKey', 'sha256:1a67d9992d18faca3d2b86eab2a4fdb595c4051495cc756bf6b758c27d52ab9c'],
      ['lease.id', 'sha256:d2f8ddc140f9051533b865cb1af5cea897e9bc31dcbcb7a0d4f5baeb485d1b67'],
      ['lease.fencingGeneration', 'sha256:5ac3587c3d1ecfca32dc8521a533cddb1c0c1e121e1fb86ca6952f4c94dcaca6'],
      ['cancellationGeneration', 'sha256:fac62f25ce8bc16f94c73594617cfe76cdd95b7d9de6a61021fec4cedfa71b8c'],
      ['expiresAt', 'sha256:a4da86f285ad08e8f397e4d649953946433b64454de4106269ce5e996bc913c9'],
      ['frozenAt', 'sha256:3aec59b860a1e9c1af7b0e164379f40e4ce0f8d987bc073f52e975f6236924b5'],
    ]);

    for (const [field, mutation] of [
      ['protocolVersion', { protocolVersion: '0.5' }],
      ['revision', { revision: 2 }],
      ['authority.useIndex', { authority: { ...intent.authority, useIndex: 2 } }],
      ['state', { state: 'issued' }],
    ] as const) {
      expect(effectIntentV04Schema.safeParse({ ...intent, ...mutation }).success, field).toBe(false);
    }
  });

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

    const retry = {
      ...states[5],
      basis: {
        ...states[5].basis,
        digest: `sha256:${sha256Hex(
          canonicalizeEffectReconciliationV04ForDigest(states[1]),
        )}`,
      },
    };
    const terminalAmbiguity = {
      ...states[6],
      basis: {
        ...states[6].basis,
        digest: `sha256:${sha256Hex(
          canonicalizeEffectReconciliationV04ForDigest(states[4]),
        )}`,
      },
    };

    for (const state of [...states.slice(0, 5), retry, terminalAmbiguity]) {
      expect(effectReconciliationV04Schema.parse(state), state.state).toEqual(state);
    }
    for (const state of states.slice(0, 5)) {
      expect(verifier.verifyReconciliationBinding(intent, state)).toEqual(state);
    }
    expect(verifier.verifyReconciliationBinding(intent, retry, states[1])).toEqual(retry);
    expect(
      verifier.verifyReconciliationBinding(intent, terminalAmbiguity, states[4]),
    ).toEqual(terminalAmbiguity);

    const unavailableAsRetry = {
      ...retry,
      basis: {
        ...retry.basis,
        reconciliationId: states[3].id,
        digest: `sha256:${sha256Hex(
          canonicalizeEffectReconciliationV04ForDigest(states[3]),
        )}`,
      },
    };
    expect(effectReconciliationV04Schema.parse(unavailableAsRetry)).toEqual(unavailableAsRetry);
    expect(
      () => verifier.verifyReconciliationBinding(intent, unavailableAsRetry, states[3]),
    ).toThrow('retry requires the referenced authoritative_not_applied reconciliation record');
    const unavailableRetryBasis = effectReconciliationV04Schema.safeParse({
      ...retry,
      basis: { ...retry.basis, kind: 'unavailable' },
    });
    expect(unavailableRetryBasis.success).toBe(false);
    if (unavailableRetryBasis.success) {
      throw new Error('retry must reject an unavailable basis kind');
    }
    expect(unavailableRetryBasis.error.issues).toEqual([{
      code: 'invalid_value',
      values: ['authoritative_not_applied'],
      path: ['basis', 'kind'],
      message: 'Invalid input: expected "authoritative_not_applied"',
    }]);
    for (const basisMutation of [
      { reconciliationId: 'effect_reconciliation_other' },
      { digest: `sha256:${'f'.repeat(64)}` },
    ]) {
      expect(() => verifier.verifyReconciliationBinding(intent, {
        ...retry,
        basis: { ...retry.basis, ...basisMutation },
      }, states[1])).toThrow(
        'reconciliation basis must bind the exact referenced record ID and digest',
      );
    }

    const unavailableAsUnknownTerminal = {
      ...terminalAmbiguity,
      basis: {
        ...terminalAmbiguity.basis,
        reconciliationId: states[3].id,
        digest: `sha256:${sha256Hex(
          canonicalizeEffectReconciliationV04ForDigest(states[3]),
        )}`,
      },
    };
    expect(() => verifier.verifyReconciliationBinding(
      intent,
      unavailableAsUnknownTerminal,
      states[3],
    )).toThrow(
      'terminal ambiguity basis must match the referenced unavailable or unknown record',
    );

    expect(effectReconciliationV04Schema.safeParse({
      ...retry,
      basis: { ...retry.basis, kind: 'unknown' },
    }).success).toBe(false);

    const unknown = states[4];
    expect(effectReconciliationV04Schema.safeParse({
      ...unknown,
      state: 'authoritative_not_applied',
    }).success).toBe(false);
    expect(effectReconciliationV04Schema.safeParse({
      ...states[3],
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
        ...terminalAmbiguity,
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
          () => verifier.verifyReconciliationBinding(
            intent,
            rejection.value,
            rejection.referenced,
          ),
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
