// Open sign-up: joining Waldo without an invite. OPEN_SIGNUP "1" turns it on, and only while the agreements are offered
// (APP_AGREEMENTS "1") and the month's model spend is counted (WALDO_COST_LEDGER_SYNC "on"): an open owner is held until they
// accept the agreements, and their lower spend ceiling counts only while the ledger does. Otherwise joining takes an invite.

export type OpenSignupEnv = Readonly<{
  OPEN_SIGNUP?: string; OPEN_SIGNUP_DAILY_CAP?: string; OPEN_SIGNUP_TOTAL_CAP?: string; OPEN_SIGNUP_SPEND_CEILING_USD?: string;
  APP_AGREEMENTS?: string; WALDO_COST_LEDGER_SYNC?: string;
}>;
// What one sign-in call needs to join someone openly: the caps the router signs into the join, and the caller's address for
// its attempt limit.
export type OpenSignup = Readonly<{ dailyCap: number; totalCap: number; ip: string }>;

// Open joins a day from one address, and attempts a day for one email, past which the join answers like any refusal.
export const OPEN_SIGNUP_IP_DAILY_LIMIT = 5;
export const OPEN_SIGNUP_EMAIL_DAILY_LIMIT = 3;
// An open owner's monthly ceiling when OPEN_SIGNUP_SPEND_CEILING_USD is not a positive amount.
export const OPEN_SIGNUP_FALLBACK_CEILING_USD = 5;

const CAP = /^[1-9][0-9]{0,2}$/;

// The caps for this deployment, or null while open sign-up is off. Turned on without its preconditions, it stays off and
// says so on each sign-in that would have used it.
export const openSignupCaps = (env: OpenSignupEnv): Readonly<{ dailyCap: number; totalCap: number }> | null => {
  if (env.OPEN_SIGNUP !== '1') return null;
  const daily = env.OPEN_SIGNUP_DAILY_CAP ?? '', total = env.OPEN_SIGNUP_TOTAL_CAP ?? '';
  if (env.APP_AGREEMENTS !== '1' || env.WALDO_COST_LEDGER_SYNC !== 'on' || !CAP.test(daily) || !CAP.test(total)) {
    console.error(JSON.stringify({ hop: 'open_signup', ok: false, code: 'open_signup_misconfigured' }));
    return null;
  }
  return { dailyCap: Number(daily), totalCap: Number(total) };
};

export const openSignupFor = (env: OpenSignupEnv, request: Request): OpenSignup | undefined => {
  const caps = openSignupCaps(env);
  return caps ? { ...caps, ip: request.headers.get('cf-connecting-ip') ?? 'unknown' } : undefined;
};

export const openOwnerCeilingUsd = (env: OpenSignupEnv): number => {
  const value = Number(env.OPEN_SIGNUP_SPEND_CEILING_USD);
  return /^[0-9]+(\.[0-9]+)?$/.test(env.OPEN_SIGNUP_SPEND_CEILING_USD ?? '') && value > 0 ? value : OPEN_SIGNUP_FALLBACK_CEILING_USD;
};
