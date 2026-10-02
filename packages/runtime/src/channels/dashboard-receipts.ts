// Write receipts for the dashboard: the console's own notice for an action key, with a closed
// outcome. Messages come from NOTICES so the API and the console cannot drift (test pins the key
// sets). An unknown key collapses to the `invalid` receipt and is never echoed back.
import { NOTICES } from './console';

export const DASHBOARD_RECEIPT_KEYS = Object.keys(NOTICES);

type Outcome = 'applied' | 'incomplete' | 'failed';
const OUTCOME: Readonly<Record<string, Outcome>> = {
  'spot.forget.incomplete': 'incomplete',
  'google.connect.failed': 'failed', 'file.unavailable': 'failed', invalid: 'failed',
};

export const dashboardReceipt = (key: string | null) => {
  const known = key !== null && Object.hasOwn(NOTICES, key) ? key : 'invalid';
  return { version: 1 as const, key: known, outcome: OUTCOME[known] ?? 'applied' as Outcome, message: NOTICES[known]! };
};
