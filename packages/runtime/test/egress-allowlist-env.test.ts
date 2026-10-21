import { describe, expect, it } from 'vitest';
import { parseEgressAllowlistEnv } from '../src/hooks/egress-policy';

// WALDO_EGRESS_ALLOWLIST feeds the browse-tool egress hook. Unset or empty stays fail-closed
// (undefined = 'allowlist_unavailable'); named hosts are normalized for the hook's matcher.
describe('parseEgressAllowlistEnv', () => {
  it('unset or empty stays fail-closed', () => {
    expect(parseEgressAllowlistEnv(undefined)).toBeUndefined();
    expect(parseEgressAllowlistEnv('')).toBeUndefined();
    expect(parseEgressAllowlistEnv(' , , ')).toBeUndefined();
  });
  it('parses, trims and lowercases hosts', () => {
    expect(parseEgressAllowlistEnv(' Example.COM , en.wikipedia.org ')).toEqual(['example.com', 'en.wikipedia.org']);
  });
});
