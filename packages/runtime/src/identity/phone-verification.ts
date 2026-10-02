import { withRequestTimeout } from './request-timeout';

export type PhoneReference = Readonly<{ service: string; sid: string; phone: string }>;
export type PhoneProviderOutcome = Readonly<{ kind: 'pending' | 'approved'; reference: PhoneReference }>
  | Readonly<{ kind: 'expired' | 'throttled' | 'unknown' }>;
export type PhoneVerificationProvider = Readonly<{
  service: string;
  start(phone: string): Promise<PhoneProviderOutcome>;
  check(reference: PhoneReference, code: string): Promise<PhoneProviderOutcome>;
}>;
export type TwilioPhoneCredentials = Readonly<{ account: string; token: string; service: string }>;
const e164 = /^\+[1-9]\d{6,14}$/;
const serviceSid = /^VA[0-9a-fA-F]{32}$/;
const verificationSid = /^VE[0-9a-fA-F]{32}$/;

// No runtime caller or credential binding enables this adapter. Email Auth is separate.
export const twilioPhoneVerification = (credentials: TwilioPhoneCredentials | null, fetcher: typeof fetch = fetch): PhoneVerificationProvider | null => {
  if (!credentials || !/^AC[0-9a-fA-F]{32}$/.test(credentials.account) || !serviceSid.test(credentials.service)
    || !credentials.token || /[^\x20-\x7e]/.test(credentials.token)) return null;
  const { account, token, service } = credentials;
  const request = async (resource: 'Verifications' | 'VerificationCheck', params: Record<string, string>, expected?: PhoneReference): Promise<PhoneProviderOutcome> => {
    try {
      return await withRequestTimeout(async signal => {
        const response = await fetcher(`https://verify.twilio.com/v2/Services/${service}/${resource}`, {
          method: 'POST', redirect: 'error', signal,
          headers: { authorization: `Basic ${btoa(`${account}:${token}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(),
        });
        if (response.status === 429) return { kind: 'throttled' };
        if (resource === 'VerificationCheck' && response.status === 404) return { kind: 'expired' };
        if (!response.ok) return { kind: 'unknown' };
        const data = await response.json() as Record<string, unknown>;
        if (!data || data.service_sid !== service || data.to !== (expected?.phone ?? params.To) || data.channel !== 'sms'
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
