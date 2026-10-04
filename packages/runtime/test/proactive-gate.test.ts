import { describe, expect, it } from 'vitest';
import { proactiveGate } from '../src/channels/proactive-gate';

// Per-owner gate for source-grounded proactive work (mail follow-up, calendar prep).
// All inputs typed; the deployment flag stays the master switch, the owner setting is per owner.
const base = { flag: '1', ownerEnabled: true, googleConnected: true, proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' as const }, now: Date.parse('2026-10-04T12:00:00Z'), timezone: 'UTC' };

describe('proactiveGate', () => {
  it('opens only when flag, owner setting and Google connection all hold', () => {
    expect(proactiveGate(base)).toEqual({ open: true });
  });
  it('the deployment flag off beats an owner who enabled it', () => {
    expect(proactiveGate({ ...base, flag: '0' })).toEqual({ open: false, reason: 'flag_off' });
    expect(proactiveGate({ ...base, flag: undefined })).toEqual({ open: false, reason: 'flag_off' });
  });
  it('an owner who has not enabled it stays closed even with the flag on (owner B unaffected by owner A)', () => {
    expect(proactiveGate({ ...base, ownerEnabled: false })).toEqual({ open: false, reason: 'owner_off' });
  });
  it('no Google connection stays closed', () => {
    expect(proactiveGate({ ...base, googleConnected: false })).toEqual({ open: false, reason: 'no_google' });
  });
  it('volume low and quiet hours close it', () => {
    expect(proactiveGate({ ...base, proactivity: { ...base.proactivity, volume: 'low' } })).toEqual({ open: false, reason: 'volume_low' });
    expect(proactiveGate({ ...base, proactivity: { quiet_start: '11:00', quiet_end: '13:00', volume: 'normal' } })).toEqual({ open: false, reason: 'quiet_hours' });
  });
});
