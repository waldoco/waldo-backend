import {
  acceptTrustedInvocation,
  runtimeInvocationV2RecordSchema,
  TOOL_PERMISSIONS,
  toolNameSchema,
} from '@waldo/contracts';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  initialTrustedRunV2State,
  parseTrustedRunV2State,
} from '../src/run-loop/trusted-v2';

const RUNS = 100;

function trustedScheduledEnvelope() {
  const accepted = acceptTrustedInvocation({
    admission_source: 'trusted_scheduler',
    verified_authority: {
      principal_ref: 'prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      tenant_ref: 'ten_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      verification_ref: 'ver_cccccccccccccccccccccccccccccccc',
    },
    input_refs: [
      {
        input_ref: 'inp_dddddddddddddddddddddddddddddddd',
        content_digest: `sha256:${'e'.repeat(64)}`,
      },
    ],
    intent: { kind: 'assemble_brief', variant: 'morning' },
    occurrence: {
      occurrence_ref: 'occ_ffffffffffffffffffffffffffffffff',
      occurred_at: 1_784_320_000_000,
    },
    idempotency_ref: 'idem_11111111111111111111111111111111',
    accepted_at: 1_784_320_000_001,
  });
  if (!accepted.ok) throw new Error(`trusted V2 property fixture was rejected: ${accepted.error.code}`);
  return accepted.value;
}

const invocation = trustedScheduledEnvelope();
const validState = initialTrustedRunV2State({
  canonicalIdentityHash: 'a'.repeat(64),
  snapshotRef: 'snp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  snapshotAt: 1_784_320_000_002,
  record: runtimeInvocationV2RecordSchema.parse({
    format: 'invocation_contract_v2',
    record_version: 2,
    invocation,
    context: null,
    tool_checkpoints: [],
    persisted_at: 1_784_320_000_003,
  }),
});
const expectedToolAcl = [...TOOL_PERMISSIONS[invocation.runtime_binding.trigger]];

function cloneValidState(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validState)) as Record<string, unknown>;
}

function parserAccepts(value: unknown): boolean {
  try {
    parseTrustedRunV2State(value);
    return true;
  } catch {
    return false;
  }
}

const unknownFieldTarget = fc.constantFrom('state', 'snapshot', 'evidence');
const unknownFieldName = fc
  .stringMatching(/^[a-z]{1,20}$/)
  .map((suffix) => `unknown_${suffix}`);
const unknownFieldValue = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
const toolAclEntry = fc.oneof(
  fc.constantFrom(...toolNameSchema.options),
  fc.stringMatching(/^unknown_[a-z]{1,20}$/),
);

describe('trusted V2 sidecar parser properties', () => {
  it('accepts the valid scheduled-brief fixture', () => {
    expect(parseTrustedRunV2State(cloneValidState())).toEqual(validState);
  });

  it('rejects generated unknown fields in every sidecar-owned strict record', () => {
    fc.assert(
      fc.property(unknownFieldTarget, unknownFieldName, unknownFieldValue, (target, key, value) => {
        const state = cloneValidState();
        switch (target) {
          case 'state':
            state[key] = value;
            break;
          case 'snapshot': {
            const snapshot = state.snapshot as Record<string, unknown>;
            state.snapshot = { ...snapshot, [key]: value };
            break;
          }
          case 'evidence': {
            const evidence = state.evidence as Record<string, unknown>;
            state.evidence = { ...evidence, [key]: value };
            break;
          }
        }

        expect(parserAccepts(state)).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('accepts only the exact ACL derived from the trusted trigger', () => {
    fc.assert(
      fc.property(fc.array(toolAclEntry, { maxLength: 32 }), (toolAcl) => {
        const state = cloneValidState();
        const evidence = state.evidence as Record<string, unknown>;
        state.evidence = { ...evidence, tool_acl: toolAcl };

        const matchesTrustedTrigger =
          toolAcl.length === expectedToolAcl.length &&
          toolAcl.every((tool, index) => tool === expectedToolAcl[index]);
        expect(parserAccepts(state)).toBe(matchesTrustedTrigger);
      }),
      { numRuns: RUNS },
    );
  });
});
