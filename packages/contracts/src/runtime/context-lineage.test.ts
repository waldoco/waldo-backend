import { describe, expect, it } from 'vitest';
import { runtimeContextCheckpointSchema, runtimeContextSourceSchema } from './invocation';

const ref = (prefix: string, n = 1) => `${prefix}_${n.toString(16).padStart(32, '0')}`;
const source = (extra: Record<string, unknown> = {}) => ({
  source_ref: ref('src'),
  source_kind: 'invocation_input' as const,
  scope: 'thread' as const,
  source_taint: null,
  produced_at: 1_700_000_000_100,
  ...extra,
});
const checkpoint = (version: 2 | 3, sources: unknown[]) => ({
  context_version: version,
  context_ref: ref('ctx'),
  principal_ref: ref('prn'),
  tenant_ref: ref('ten'),
  invocation_idempotency_ref: ref('idem'),
  produced_at: 1_700_000_000_200,
  source_taint: null,
  sanitisation: 'passed' as const,
  sources,
});

describe('context source lineage (context_version 3)', () => {
  it('v2 records still parse unchanged and may not carry a lineage label', () => {
    expect(runtimeContextCheckpointSchema.safeParse(checkpoint(2, [source()])).success).toBe(true);
    expect(runtimeContextCheckpointSchema.safeParse(checkpoint(2, [source({ lineage: 'canonical_v1' })])).success).toBe(false);
  });

  it('v3 requires a lineage label on every source', () => {
    expect(runtimeContextCheckpointSchema.safeParse(checkpoint(3, [source({ lineage: 'canonical_v1' })])).success).toBe(true);
    expect(runtimeContextCheckpointSchema.safeParse(checkpoint(3, [source()])).success).toBe(false);
    expect(runtimeContextCheckpointSchema.safeParse(checkpoint(3, [source({ lineage: 'canonical_v1' }), source({ source_ref: ref('src', 2) })])).success).toBe(false);
  });

  it('a canonical v3 checkpoint rejects a legacy_preserved source, so legacy history never becomes context', () => {
    const result = runtimeContextCheckpointSchema.safeParse(checkpoint(3, [source({ lineage: 'canonical_v1' }), source({ source_ref: ref('src', 2), lineage: 'legacy_preserved' })]));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('legacy');
  });

  it('the label is a closed enum; free text and unknown values are rejected', () => {
    for (const lineage of ['canonical', 'legacy', 'CANONICAL_V1', '', null, 'canonical_v1 ']) {
      expect(runtimeContextSourceSchema.safeParse(source({ lineage })).success).toBe(false);
    }
    expect(runtimeContextSourceSchema.safeParse(source({ lineage: 'legacy_preserved' })).success).toBe(true);
  });
});
