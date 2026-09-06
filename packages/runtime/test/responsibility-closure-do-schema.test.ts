import { describe, expect, it } from 'vitest';
import { DO_PRODUCT_TABLES, DO_SCHEMA_VERSION } from '../src/do-schema';

const RESPONSIBILITY_CLOSURE_TABLES = [
  'acceptance_checks',
  'closure_evidence',
  'closure_verifications',
  'closure_acceptances',
  'closure_commands',
  'closure_projection',
  'closure_projection_state',
] as const;

describe('responsibility closure Durable Object schema', () => {
  it('allocates one additive v8 schema with the canonical closure tables', () => {
    expect(DO_SCHEMA_VERSION).toBe(8);
    for (const table of RESPONSIBILITY_CLOSURE_TABLES) {
      expect(DO_PRODUCT_TABLES).toContain(table);
    }
  });
});
