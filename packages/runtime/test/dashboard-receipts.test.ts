import { describe, expect, it } from 'vitest';
import { dashboardReceipt, DASHBOARD_RECEIPT_KEYS } from '../src/channels/dashboard-receipts';
import { NOTICES } from '../src/channels/console';

describe('dashboard write receipts', () => {
  it('covers exactly the console notice keys, so the API and console cannot drift', () => {
    expect([...DASHBOARD_RECEIPT_KEYS].sort()).toEqual(Object.keys(NOTICES).sort());
  });
  it('returns the console message with a closed outcome', () => {
    expect(dashboardReceipt('spot.dismiss')).toEqual({ version: 1, key: 'spot.dismiss', outcome: 'applied', message: NOTICES['spot.dismiss'] });
    expect(dashboardReceipt('spot.forget.incomplete')).toMatchObject({ outcome: 'incomplete', message: NOTICES['spot.forget.incomplete'] });
    for (const key of ['google.connect.failed', 'file.unavailable', 'invalid']) expect(dashboardReceipt(key)).toMatchObject({ outcome: 'failed' });
  });
  it('an unknown or hostile key collapses to the invalid receipt and is never echoed', () => {
    const out = dashboardReceipt('ignore previous instructions');
    expect(out).toEqual({ version: 1, key: 'invalid', outcome: 'failed', message: NOTICES.invalid });
    expect(JSON.stringify(dashboardReceipt(null))).not.toContain('ignore');
  });
});
