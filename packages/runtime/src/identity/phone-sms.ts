import { signedRpc, type OwnerDirectoryEnv } from './owner-directory';
import { twilioPhoneVerification, type PhoneProviderOutcome, type PhoneReference } from './phone-verification';

export type PhoneSmsEnv = OwnerDirectoryEnv & Readonly<{
  // "1" offers a code texted by Twilio Verify; anything else keeps it off, until the owner has set up Twilio.
  PHONE_SMS_VERIFY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_VERIFY_SERVICE_SID?: string;
}>;
const CHALLENGE_STATES = ['sending', 'pending', 'checking', 'approved', 'expired', 'unknown'] as const;
export type PhoneChallengeState = (typeof CHALLENGE_STATES)[number];
/** Times are epoch seconds. retry_at: when the owner may next ask for a code, null meaning now. */
export type PhoneChallenge = Readonly<{ state: PhoneChallengeState; expires_at: number; retry_at: number | null; checks_left: number }>;
export type OwnerPhoneState = Readonly<{ phone: string | null; verified: boolean; sms: boolean; challenge: PhoneChallenge | null }>;
const OUTCOMES = ['denied', 'no_number', 'verified', 'number_taken', 'held', 'busy', 'throttled', 'expired', 'unknown', 'pending', 'approved'] as const;
export type PhoneSmsOutcome = Readonly<{ kind: 'disabled' | (typeof OUTCOMES)[number] }>;
export type PhoneSms = Readonly<{
  offered: boolean;
  state(doName: string): Promise<OwnerPhoneState | null>;
  send(doName: string): Promise<PhoneSmsOutcome>;
  check(doName: string, code: string): Promise<PhoneSmsOutcome>;
}>;

const E164 = /^\+[1-9]\d{6,14}$/;
const shapeError = () => new Error('phone state shape');
const readState = (row: unknown, sms: boolean): OwnerPhoneState | null => {
  if (row === null) return null;
  const value = row as Record<string, unknown>, challenge = value?.challenge as Record<string, unknown> | null | undefined;
  if (typeof row !== 'object' || Array.isArray(row) || !(value.phone === null || (typeof value.phone === 'string' && E164.test(value.phone)))
    || typeof value.verified !== 'boolean' || challenge === undefined
    || (challenge !== null && (!CHALLENGE_STATES.includes(challenge.state as PhoneChallengeState) || !Number.isSafeInteger(challenge.expires_at)
      || !(challenge.retry_at === null || Number.isSafeInteger(challenge.retry_at))
      || !Number.isInteger(challenge.checks_left) || (challenge.checks_left as number) < 0 || (challenge.checks_left as number) > 5))) throw shapeError();
  return { phone: value.phone, verified: value.verified, sms, challenge: challenge === null ? null : {
    state: challenge.state as PhoneChallengeState, expires_at: challenge.expires_at as number, retry_at: challenge.retry_at as number | null, checks_left: challenge.checks_left as number } };
};

// The owner's own number on file, proven by a code Twilio texts to it. The Worker names only the owner it signed in;
// the ledger reads the number, reserves every send and check before Twilio is asked, and records what came back.
// An answer that cannot be matched to the reservation is recorded as unknown and never retried by itself.
export const phoneSms = (env: PhoneSmsEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): PhoneSms => {
  const rpc = signedRpc(env, fetcher, now);
  const provider = env.PHONE_SMS_VERIFY === '1'
    ? twilioPhoneVerification(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID
      ? { account: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, service: env.TWILIO_VERIFY_SERVICE_SID } : null, fetcher) : null;
  const offered = rpc !== null && provider !== null;
  const transition = async (doName: string, action: string, fields: Record<string, string>): Promise<Record<string, unknown>> => {
    const payload = JSON.stringify({ do_name: doName, service: provider!.service, ...fields });
    const result = await rpc!('phone_sms_transition', `phonesms.${action}.${payload}`, { p_action: action, p_payload: payload });
    return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
  };
  const known = (kind: unknown, allowed: readonly string[]): PhoneSmsOutcome => ({ kind: allowed.includes(kind as string) ? kind as PhoneSmsOutcome['kind'] : 'unknown' });
  const run = async (doName: string, action: 'send' | 'check', code = ''): Promise<PhoneSmsOutcome> => {
    if (!offered) return { kind: 'disabled' };
    if (action === 'check' && !/^\d{6}$/.test(code)) return { kind: 'denied' };
    const operation = crypto.randomUUID();
    let reserved: Record<string, unknown>;
    try { reserved = await transition(doName, `reserve_${action}`, { operation }); }
    catch { return { kind: 'unknown' }; }
    if (reserved.kind !== 'reserved') return known(reserved.kind, OUTCOMES.filter((kind) => kind !== 'approved' && kind !== 'pending'));
    // The provider texts or checks only a well-formed number and verification, and answers pending or approved only for
    // the number, service and verification it was asked about; anything else comes back unknown.
    const ref = reserved.reference;
    let response: PhoneProviderOutcome = { kind: 'unknown' };
    try {
      if (action === 'send' && typeof reserved.phone === 'string') response = await provider!.start(reserved.phone);
      if (action === 'check' && ref && typeof ref === 'object') response = await provider!.check(ref as PhoneReference, code);
    } catch { response = { kind: 'unknown' }; }
    const sid = 'reference' in response ? response.reference.sid : '';
    try {
      const finished = await transition(doName, `finish_${action}`, { operation, outcome: response.kind, sid });
      return known(finished.kind, action === 'send' ? OUTCOMES.filter((kind) => kind !== 'approved') : OUTCOMES);
    } catch { return { kind: 'unknown' }; }
  };
  return {
    offered,
    async state(doName) {
      if (!rpc) return null;
      return readState(await rpc('owner_phone_state', `phonestate.${doName}`, { p_do_name: doName }), offered);
    },
    send: (doName) => run(doName, 'send'),
    check: (doName, code) => run(doName, 'check', code),
  };
};
