import { describe, expect, it } from 'vitest';
import { gateTraceEntry, resolveCaptureText } from '../src/observability/trace-privacy';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';

const entry: TurnLogEntry = { trace: 'tg-1', hop: 'receipt', ms: 0, ok: true, owner_id: '11111111-2222-4333-8444-555555555555', owner_email: 'owner@example.com', owner_identity: 'verified' };

describe('verified owner email follows the capture switch', () => {
  it('is emitted when capture is on (staging)', () => {
    expect(gateTraceEntry(entry, true)).toMatchObject({ owner_id: entry.owner_id, owner_email: 'owner@example.com', owner_identity: 'verified' });
  });
  it('is withheld when capture is off, and owner_id stays', () => {
    const gated = gateTraceEntry(entry, false);
    expect(gated).toMatchObject({ owner_id: entry.owner_id, owner_email: 'unknown', owner_identity: 'email_unavailable' });
    expect(JSON.stringify(gated)).not.toContain('owner@example.com');
  });
  it('is withheld on the memory-evidence and health hops too', () => {
    for (const hop of ['constellation_evidence', 'health_context']) expect(JSON.stringify(gateTraceEntry({ ...entry, hop }, false))).not.toContain('owner@example.com');
  });
  it('is withheld in production even if capture is requested', () => {
    const capture = resolveCaptureText({ LANGFUSE_CAPTURE_TEXT: 'true', WALDO_ENVIRONMENT: 'production' });
    expect(JSON.stringify(gateTraceEntry(entry, capture))).not.toContain('owner@example.com');
  });
});
