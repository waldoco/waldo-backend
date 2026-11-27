// Open sign-up: joining Waldo without an invite. OPEN_SIGNUP "1" turns it on, and only while the agreements are offered
// (APP_AGREEMENTS "1") and the month's model spend is counted (WALDO_COST_LEDGER_SYNC "on"): an open owner is held until they
// accept the agreements, and their own spend ceiling counts only while the ledger does. There is no join cap; the throttles
// below stop abuse. Otherwise no new account is made.

import { positiveUsd } from '../llm/cost-ledger';

export type OpenSignupEnv = Readonly<{
  OPEN_SIGNUP?: string; OPEN_SIGNUP_SPEND_CEILING_USD?: string; APP_AGREEMENTS?: string; WALDO_COST_LEDGER_SYNC?: string;
}>;
// What one sign-in call needs to join someone openly: the caller's address, for its attempt limit.
export type OpenSignup = Readonly<{ ip: string }>;

// Open-join attempts a day from one network address, and for one email, past which the join is refused as join_limited. The
// address limit carries a cohort joining together from one network, such as a gym's members on its Wi-Fi.
export const OPEN_SIGNUP_IP_DAILY_LIMIT = 300;
export const OPEN_SIGNUP_EMAIL_DAILY_LIMIT = 5;
// An open owner's monthly ceiling when OPEN_SIGNUP_SPEND_CEILING_USD is not a positive amount.
export const OPEN_SIGNUP_FALLBACK_CEILING_USD = 5;

// Whether this deployment takes new accounts. Turned on without its preconditions, it stays off and says so each time.
export const openSignupOn = (env: OpenSignupEnv): boolean => {
  if (env.OPEN_SIGNUP !== '1') return false;
  if (env.APP_AGREEMENTS !== '1' || env.WALDO_COST_LEDGER_SYNC !== 'on') {
    console.error(JSON.stringify({ hop: 'open_signup', ok: false, code: 'open_signup_misconfigured' }));
    return false;
  }
  return true;
};

export const openSignupFor = (env: OpenSignupEnv, request: Request): OpenSignup | undefined =>
  openSignupOn(env) ? { ip: request.headers.get('cf-connecting-ip') ?? 'unknown' } : undefined;

export const openOwnerCeilingUsd = (env: OpenSignupEnv): number =>
  positiveUsd(env.OPEN_SIGNUP_SPEND_CEILING_USD) ?? OPEN_SIGNUP_FALLBACK_CEILING_USD;
