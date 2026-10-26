import { signedRpc, type OwnerDirectoryEnv } from './owner-directory';
import { twilioPhoneVerification, type PhoneProviderOutcome, type PhoneReference } from './phone-verification';

export type PhoneSmsEnv = OwnerDirectoryEnv & Readonly<{
  // "1" offers a code texted by Twilio Verify; anything else keeps it off, until the owner has set up Twilio.
  PHONE_SMS_VERIFY?: string;
  // The country codes Waldo may text, comma-separated ("+91,+44"), and the server's cap on texts a UTC day. Both are
  // signed into every reservation; a missing or malformed value keeps texting off.
  PHONE_SMS_COUNTRIES?: string;
  PHONE_SMS_DAILY_LIMIT?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  // An API key, standard or restricted to Verify, used in place of the account token whenever its SID is set.
  TWILIO_API_KEY_SID?: string;
  TWILIO_API_KEY_SECRET?: string;
  TWILIO_VERIFY_SERVICE_SID?: string;
}>;
const CHALLENGE_STATES = ['sending', 'pending', 'checking', 'approved', 'expired', 'unknown'] as const;
export type PhoneChallengeState = (typeof CHALLENGE_STATES)[number];
/** Times are epoch seconds. retry_at: when the owner may next ask for a code, null meaning now. */
export type PhoneChallenge = Readonly<{ state: PhoneChallengeState; expires_at: number; retry_at: number | null; checks_left: number }>;
export type OwnerPhoneState = Readonly<{ phone: string | null; verified: boolean; sms: boolean; challenge: PhoneChallenge | null }>;
const OUTCOMES = ['denied', 'no_number', 'verified', 'unsupported', 'number_taken', 'held', 'busy', 'throttled', 'expired', 'unknown', 'refused', 'pending', 'approved'] as const;
export type PhoneSmsOutcome = Readonly<{ kind: 'disabled' | (typeof OUTCOMES)[number] }>;
const SET_OUTCOMES = ['set', 'unchanged', 'taken', 'invalid', 'unsupported', 'throttled', 'denied'] as const;
// unlinked: on a set, the providers whose links from the old number the ledger unlinked with it.
export type PhoneSetOutcome = Readonly<{ kind: 'disabled' | 'unknown' | (typeof SET_OUTCOMES)[number]; unlinked?: readonly ('whatsapp' | 'imessage')[] }>;
const LINKED = ['whatsapp', 'imessage'] as const;
export type PhoneSms = Readonly<{
  offered: boolean;
  state(doName: string): Promise<OwnerPhoneState | null>;
  send(doName: string): Promise<PhoneSmsOutcome>;
  check(doName: string, code: string): Promise<PhoneSmsOutcome>;
  // Stores the owner's number unverified, or answers why not; a number another active owner has verified is taken.
  // byLink: the caller found the owner can prove a number by sending a link code from it, so texting need not be on.
  set(doName: string, phone: string, byLink?: boolean): Promise<PhoneSetOutcome>;
}>;

const E164 = /^\+[1-9]\d{6,14}$/;
const shapeError = () => new Error('phone state shape');
const readState = (row: unknown, texts: (phone: string) => boolean): OwnerPhoneState | null => {
  if (row === null) return null;
  const value = row as Record<string, unknown>, challenge = value?.challenge as Record<string, unknown> | null | undefined;
  if (typeof row !== 'object' || Array.isArray(row) || !(value.phone === null || (typeof value.phone === 'string' && E164.test(value.phone)))
    || typeof value.verified !== 'boolean' || challenge === undefined
    || (challenge !== null && (!CHALLENGE_STATES.includes(challenge.state as PhoneChallengeState) || !Number.isSafeInteger(challenge.expires_at)
      || !(challenge.retry_at === null || Number.isSafeInteger(challenge.retry_at))
      || !Number.isInteger(challenge.checks_left) || (challenge.checks_left as number) < 0 || (challenge.checks_left as number) > 5))) throw shapeError();
  return { phone: value.phone, verified: value.verified, sms: value.phone !== null && texts(value.phone), challenge: challenge === null ? null : {
    state: challenge.state as PhoneChallengeState, expires_at: challenge.expires_at as number, retry_at: challenge.retry_at as number | null, checks_left: challenge.checks_left as number } };
};

// The owner's own number on file, proven by a code Twilio texts to it. The Worker names only the owner it signed in;
// the ledger reads the number, reserves every send and check before Twilio is asked, and records what came back.
// An answer that cannot be matched to the reservation is recorded as unknown and never retried by itself.
export const phoneSms = (env: PhoneSmsEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): PhoneSms => {
  const rpc = signedRpc(env, fetcher, now);
  const countries = (env.PHONE_SMS_COUNTRIES ?? '').split(',').map((code) => code.trim());
  const dailyLimit = /^[1-9]\d{0,5}$/.test(env.PHONE_SMS_DAILY_LIMIT ?? '') ? Number(env.PHONE_SMS_DAILY_LIMIT) : null;
  const keyed = env.TWILIO_API_KEY_SID !== undefined && env.TWILIO_API_KEY_SID !== '';
  const countriesValid = countries.every((code) => /^\+[1-9]\d{0,2}$/.test(code));
  const provider = env.PHONE_SMS_VERIFY === '1' && countriesValid && dailyLimit !== null
    ? twilioPhoneVerification({ user: (keyed ? env.TWILIO_API_KEY_SID : env.TWILIO_ACCOUNT_SID) ?? '',
      secret: (keyed ? env.TWILIO_API_KEY_SECRET : env.TWILIO_AUTH_TOKEN) ?? '', service: env.TWILIO_VERIFY_SERVICE_SID ?? '' }, fetcher) : null;
  const offered = rpc !== null && provider !== null;
  // The ledger refuses a number outside these codes; the views use the same list so they offer only what it accepts.
  const texts = (phone: string) => offered && countries.some((code) => phone.startsWith(code));
  const transition = async (doName: string, action: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> => {
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
    try { reserved = await transition(doName, `reserve_${action}`, action === 'send' ? { operation, countries, daily_limit: dailyLimit } : { operation }); }
    catch { return { kind: 'unknown' }; }
    if (reserved.kind !== 'reserved') return known(reserved.kind, OUTCOMES.filter((kind) => kind !== 'approved' && kind !== 'pending' && kind !== 'refused'));
    // The provider texts or checks only a well-formed number and verification, and answers pending or approved only for
    // the number, service and verification it was asked about; anything else comes back unknown.
    const ref = reserved.reference;
    let response: PhoneProviderOutcome = { kind: 'unknown' };
    try {
      if (action === 'send' && typeof reserved.phone === 'string') response = await provider!.start(reserved.phone);
      if (action === 'check' && ref && typeof ref === 'object') response = await provider!.check(ref as PhoneReference, code);
    } catch { response = { kind: 'unknown' }; }
    if (response.kind === 'refused') {
      console.error(JSON.stringify({ hop: 'phone_sms', ok: false, code: 'provider_refused', resource: action === 'send' ? 'Verifications' : 'VerificationCheck',
        status: response.status, twilio_code: response.code }));
    }
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
      return readState(await rpc('owner_phone_state', `phonestate.${doName}`, { p_do_name: doName }), texts);
    },
    send: (doName) => run(doName, 'send'),
    check: (doName, code) => run(doName, 'check', code),
    // Offered with texting or a link code, so a number is set only where it can then be proven. The ledger applies the
    // same country codes either way and counts the attempts; a lost answer may have saved the number, so it reads as unknown.
    async set(doName, phone, byLink = false) {
      if (!rpc || !countriesValid || !(offered || byLink)) return { kind: 'disabled' };
      if (!E164.test(phone)) return { kind: 'invalid' };
      const payload = JSON.stringify({ do_name: doName, phone, countries });
      let result: unknown;
      try { result = await rpc!('owner_phone_set', `phoneset.${payload}`, { p_payload: payload }); } catch { return { kind: 'unknown' }; }
      const { kind, unlinked } = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      if (!SET_OUTCOMES.includes(kind as (typeof SET_OUTCOMES)[number])) return { kind: 'unknown' };
      if (kind !== 'set') return { kind: kind as (typeof SET_OUTCOMES)[number] };
      // A set always names what it unlinked; an answer that does not is not one this Worker can act on.
      if (!Array.isArray(unlinked) || !unlinked.every((provider) => LINKED.includes(provider))) return { kind: 'unknown' };
      return { kind: 'set', unlinked: unlinked as ('whatsapp' | 'imessage')[] };
    },
  };
};
