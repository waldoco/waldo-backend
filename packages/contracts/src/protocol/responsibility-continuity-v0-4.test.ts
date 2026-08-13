import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { openLoopDispositionCommandV04Schema, openLoopV04Schema, reEntryPointV04Schema } from './responsibility-continuity-v0-4';
const digest = `sha256:${'d'.repeat(64)}`;
const reentry = { protocolVersion: '0.4', id: 'reentry', ownerId: 'owner', revision: 1, subject: { kind: 'outcome', id: 'outcome', revision: 2 },
  mode: 'verification', summary: 'Verify the remaining external state.', lastStableEventId: 'event', nextAction: { kind: 'verify', ref: 'check' },
  requiredContextRecipeRef: 'recipe', requiredContextRecipeDigest: digest, evidenceGapRefs: ['gap'], artifactRefs: [], eventCursor: 5, expiresAt: null };
const loop = { protocolVersion: '0.4', id: 'loop', ownerId: 'owner', revision: 1, outcome: { id: 'outcome', revision: 2 }, workUnit: null,
  unresolvedConsequence: { kind: 'external_state_unverified', ref: 'consequence' }, responsibleParty: { kind: 'waldo', ref: null },
  nextTrigger: { kind: 'manual', ref: 'trigger' }, evidenceGapRefs: ['gap'], reEntryPointId: 'reentry', attentionClass: 'normal', state: 'open', updatedAt: '2026-08-13T12:00:00.000Z' };
describe('responsibility continuity v0.4', () => {
  it('round-trips one exact re-entry for an open loop', () => {
    expect(openLoopV04Schema.parse(loop).reEntryPointId).toBe(reEntryPointV04Schema.parse(reentry).id);
  });
  it('does not let external completion close the loop', () => {
    for (const field of ['providerDone', 'executorDone', 'deliveryDone', 'effectReceipt', 'sessionCompleted'])
      expect(openLoopV04Schema.safeParse({ ...loop, [field]: true }).success).toBe(false);
  });
  it('requires explicit Acceptance for resolution and re-entry for nonterminal dispositions', () => {
    const base = { protocolVersion: '0.4', requestId: 'request', commandType: 'open_loop.disposition', presenceRegistrationId: 'presence',
      aggregate: { kind: 'open_loop', id: 'loop', expectedRevision: 1 }, clientIssuedAt: '2026-08-13T12:00:00.000Z' };
    expect(openLoopDispositionCommandV04Schema.safeParse({ ...base, disposition: 'resolve', acceptanceId: null, reEntryPointId: null }).success).toBe(false);
    expect(openLoopDispositionCommandV04Schema.safeParse({ ...base, disposition: 'reopen', acceptanceId: null, reEntryPointId: null }).success).toBe(false);
    expect(openLoopDispositionCommandV04Schema.parse({ ...base, disposition: 'resolve', acceptanceId: 'acceptance', reEntryPointId: null }).disposition).toBe('resolve');
  });
  it('compiles both schemas', () => {
    const ajv = new Ajv2020({ strict: false });
    expect(ajv.compile(openLoopV04Schema.toJSONSchema())(loop)).toBe(true);
    expect(ajv.compile(reEntryPointV04Schema.toJSONSchema())(reentry)).toBe(true);
  });
});
