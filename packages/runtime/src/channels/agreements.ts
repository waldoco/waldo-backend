import { APP_IMPROVE_WALDO_AGREEMENT_V1, APP_IMPROVE_WALDO_RECEIPTS_V1 } from '../../../contracts/src/app/controls';
import type { ConsoleAction } from './console';
import type { ControlReceipt } from './dashboard-control-actions';

// The owner's account-level agreements, kept in the owner object. Improve Waldo for everyone is opt-in: with no choice
// recorded it reads as not given. Every choice is appended to a bounded history, so Waldo can show when and under which
// version the owner gave or withdrew it. Nothing in Waldo reads the agreement to use data yet.
type Kv = Pick<SyncKvStorage, 'get' | 'put'>;
type Choice = Readonly<{ given: boolean; version: string; at: number }>;
const IMPROVE_WALDO_KEY = 'agreement:improve_waldo';
const IMPROVE_WALDO_HISTORY_KEY = 'agreement:improve_waldo:history';
const HISTORY_MAX = 100;

export type AgreementsControls = Readonly<{ version: 1; view: 'agreements'; state: 'available'; csrf: string;
  data: Readonly<{ improve_waldo: Readonly<{ given: boolean; version: string; changed_at: number | null }>; actions: readonly ['improve_waldo.set'] }> }>;

// Whether the owner has given Improve Waldo for everyone under the current version.
export const improveWaldoGiven = (kv: Pick<Kv, 'get'>): boolean => {
  const latest = kv.get<Choice>(IMPROVE_WALDO_KEY);
  return latest?.given === true && latest.version === APP_IMPROVE_WALDO_AGREEMENT_V1.version;
};

export const agreementsControls = (kv: Pick<Kv, 'get'>, csrf: string): AgreementsControls => ({
  version: 1, view: 'agreements', state: 'available', csrf,
  data: { improve_waldo: { given: improveWaldoGiven(kv), version: APP_IMPROVE_WALDO_AGREEMENT_V1.version, changed_at: kv.get<Choice>(IMPROVE_WALDO_KEY)?.at ?? null }, actions: ['improve_waldo.set'] },
});

// fields.notice is the agreement version the owner was shown; a choice made against other wording is refused.
export const agreementsControlAct = (kv: Kv, action: ConsoleAction, fields: Readonly<Record<string, string>>, now: () => number): ControlReceipt => {
  if (action.action !== 'improve_waldo.set' || (action.value !== 'given' && action.value !== 'withdrawn')) return APP_IMPROVE_WALDO_RECEIPTS_V1.unknown;
  if (fields.notice !== APP_IMPROVE_WALDO_AGREEMENT_V1.version) return APP_IMPROVE_WALDO_RECEIPTS_V1.notice_stale;
  const given = action.value === 'given';
  if (improveWaldoGiven(kv) === given) return APP_IMPROVE_WALDO_RECEIPTS_V1[given ? 'already_given' : 'already_withdrawn'];
  const choice: Choice = { given, version: APP_IMPROVE_WALDO_AGREEMENT_V1.version, at: now() };
  kv.put(IMPROVE_WALDO_HISTORY_KEY, [...(kv.get<readonly Choice[]>(IMPROVE_WALDO_HISTORY_KEY) ?? []), choice].slice(-HISTORY_MAX));
  kv.put(IMPROVE_WALDO_KEY, choice);
  return APP_IMPROVE_WALDO_RECEIPTS_V1[given ? 'given' : 'withdrawn'];
};
