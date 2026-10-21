import { describe, expect, it } from 'vitest';
import { listOwnerFindingsArgsSchema, recordOwnerFindingArgsSchema } from './lookup';

const finding = { category: 'work', text: 'Product manager at Acme', source_url: 'https://acme.example/team', evidence_quote: 'Sam Rivera, product manager', anchor: '@samrivera' };

describe('owner look-up tool arguments', () => {
  it('records one fact about the owner with its source, quote and anchor', () => {
    expect(recordOwnerFindingArgsSchema.safeParse(finding).success).toBe(true);
    for (const bad of [
      { ...finding, category: 'religion' }, { ...finding, category: 'politics' }, { ...finding, category: 'health' }, { ...finding, category: 'caste' }, { ...finding, category: 'sexuality' },
      { ...finding, subject: 'Priya' }, { ...finding, source_url: 'javascript:alert(1)' }, { ...finding, source_url: 'not a url' },
      { ...finding, source_url: 'ftp://acme.example/team' }, { ...finding, source_url: 'https://' }, { ...finding, source_url: 'https://acme.example/a b' }, { ...finding, source_url: `https://acme.example/${'a'.repeat(2048)}` },
      { ...finding, anchor: 'ab' }, { ...finding, evidence_quote: ' ' }, { ...finding, evidence_quote: 'Pune' }, { ...finding, text: 'x'.repeat(301) },
      (({ anchor: _a, ...rest }) => rest)(finding), (({ source_url: _s, ...rest }) => rest)(finding),
    ]) expect(recordOwnerFindingArgsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  // Egress policy treats a format: uri argument as a destination the tool may reach. source_url is a citation checked against
  // the pages this run read; nothing fetches it, so declaring it as egress would block recording whenever no allowlist is set.
  it('does not present the citation as a destination to reach', () => {
    expect(JSON.stringify(recordOwnerFindingArgsSchema.toJSONSchema())).not.toContain('"format":"uri"');
  });
  it('lists a bounded page', () => {
    expect(listOwnerFindingsArgsSchema.parse({})).toEqual({ limit: 20 });
    expect(listOwnerFindingsArgsSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(listOwnerFindingsArgsSchema.safeParse({ limit: 5, owner: 'x' }).success).toBe(false);
  });
});
