import { describe, expect, it } from 'vitest';
import { boundedProtocolTextV04, protocolVersionV04Schema } from './responsibility-protocol-v0-4';

describe('responsibility protocol v0.4 primitives', () => {
  it('pins the version and rejects malformed Unicode', () => {
    expect(protocolVersionV04Schema.parse('0.4')).toBe('0.4');
    expect(protocolVersionV04Schema.safeParse('0.3').success).toBe(false);
    expect(boundedProtocolTextV04(8).safeParse('\ud800').success).toBe(false);
  });
});
