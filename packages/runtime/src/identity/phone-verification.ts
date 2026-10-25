import { withRequestTimeout } from './request-timeout';

export type PhoneReference = Readonly<{ service: string; sid: string; phone: string }>;
// refused: Twilio turned the request down (a 4xx other than 429), so it created and checked nothing. code is Twilio's
// numeric error code, the only part of its answer kept.
export type PhoneProviderOutcome = Readonly<{ kind: 'pending' | 'approved'; reference: PhoneReference }>
  | Readonly<{ kind: 'expired' | 'throttled' | 'unknown' }> | Readonly<{ kind: 'refused'; status: number; code: number | null }>;
export type PhoneVerificationProvider = Readonly<{
  service: string;
  start(phone: string): Promise<PhoneProviderOutcome>;
  check(reference: PhoneReference, code: string): Promise<PhoneProviderOutcome>;
}>;
/** user: the account SID with its auth token, or an API key SID (standard or restricted) with its secret. */
export type TwilioPhoneCredentials = Readonly<{ user: string; secret: string; service: string }>;
const e164 = /^\+[1-9]\d{6,14}$/;
const serviceSid = /^VA[0-9a-fA-F]{32}$/;
const verificationSid = /^VE[0-9a-fA-F]{32}$/;

// Twilio Verify owns the code: it generates, texts and checks it, so Waldo never holds one. Every answer is checked
// against the service, recipient and verification it was asked about before it can count as proof.
export const twilioPhoneVerification = (credentials: TwilioPhoneCredentials | null, fetcher: typeof fetch = fetch): PhoneVerificationProvider | null => {
  if (!credentials || !/^(AC|SK)[0-9a-fA-F]{32}$/.test(credentials.user) || !serviceSid.test(credentials.service)
    || !credentials.secret || /[^\x20-\x7e]/.test(credentials.secret)) return null;
  const { user, secret, service } = credentials;
  const request = async (resource: 'Verifications' | 'VerificationCheck', params: Record<string, string>, expected?: PhoneReference): Promise<PhoneProviderOutcome> => {
    try {
      return await withRequestTimeout(async signal => {
        const response = await fetcher(`https://verify.twilio.com/v2/Services/${service}/${resource}`, {
          method: 'POST', redirect: 'error', signal,
          headers: { authorization: `Basic ${btoa(`${user}:${secret}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(),
        });
        if (response.status === 429) return { kind: 'throttled' };
        if (resource === 'VerificationCheck' && response.status === 404) return { kind: 'expired' };
        if (response.status >= 400 && response.status < 500) {
          const error = await response.json().catch(() => null) as Record<string, unknown> | null;
          return { kind: 'refused', status: response.status, code: Number.isSafeInteger(error?.code) ? error!.code as number : null };
        }
        if (!response.ok) return { kind: 'unknown' };
        const data = await response.json() as Record<string, unknown>;
        if (!data || data.service_sid !== service || data.to !== (expected?.phone ?? params.To)
          || typeof data.sid !== 'string' || !verificationSid.test(data.sid) || (expected && data.sid !== expected.sid)) return { kind: 'unknown' };
        if (data.status !== 'pending' && data.status !== 'approved') return { kind: 'unknown' };
        if (resource === 'Verifications' && data.status !== 'pending') return { kind: 'unknown' };
        return { kind: data.status, reference: { service, sid: data.sid, phone: data.to as string } };
      });
    } catch { return { kind: 'unknown' }; } // Unknown effects are persisted and fenced by the proof coordinator.
  };
  return {
    service,
    start: async phone => e164.test(phone) ? request('Verifications', { To: phone, Channel: 'sms' }) : { kind: 'unknown' },
    check: async (reference, code) => reference.service === service && verificationSid.test(reference.sid) && e164.test(reference.phone) && /^\d{6}$/.test(code)
      ? request('VerificationCheck', { VerificationSid: reference.sid, Code: code }, reference) : { kind: 'unknown' },
  };
};
