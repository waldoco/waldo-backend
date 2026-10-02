import type { SignupProgress } from './console-signup';
import { signedRpc, type OwnerDirectoryEnv } from './owner-directory';
import type { PhoneReference, PhoneVerificationProvider, PhoneProviderOutcome } from './phone-verification';

export type SignupPhoneOutcome = Readonly<{ kind: 'disabled' | 'denied' | 'throttled' | 'expired' | 'unknown' | 'pending' | 'approved' | 'canceled' }>;
export type SignupPhoneProof = Readonly<{
  start(progress: SignupProgress): Promise<SignupPhoneOutcome>;
  check(progress: SignupProgress, code: string): Promise<SignupPhoneOutcome>;
  cancel(progress: SignupProgress): Promise<SignupPhoneOutcome>;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const outcomes = new Set(['denied', 'throttled', 'expired', 'unknown', 'pending', 'approved', 'canceled', 'reserved']);
type Reservation = { kind: 'reserved'; reference?: PhoneReference };

// No route constructs an enabled coordinator. Proof grants no owner, invite consumption or session.
export const signupPhoneProof = (env: OwnerDirectoryEnv, provider: PhoneVerificationProvider | null = null,
  fetcher: typeof fetch = fetch, now = () => Date.now()): SignupPhoneProof => {
  const rpc = provider ? signedRpc(env, fetcher, now) : null;
  const binding = (p: SignupProgress, allowExpired = false) => p.emailVerified && p.authUser && uuid.test(p.authUser) && uuid.test(p.csrf)
    && /^[0-9a-f]{64}$/.test(p.inviteHash) && p.phone && /^\+[1-9]\d{6,14}$/.test(p.phone)
    && p.email === p.email.trim().toLowerCase() && p.email.length <= 254 && !/[\s]/.test(p.email) && p.email.includes('@')
    && Number.isSafeInteger(p.expires) && (allowExpired || p.expires > Math.floor(now() / 1000)) && p.expires > 0 && p.expires <= Math.floor(now() / 1000) + 900
    ? { attempt: p.csrf, authUser: p.authUser, email: p.email, inviteHash: p.inviteHash, phone: p.phone, expires: p.expires, service: provider!.service } : null;
  const transition = async (action: string, p: SignupProgress, extra: Record<string, unknown> = {}): Promise<SignupPhoneOutcome | Reservation> => {
    const scope = binding(p, action === 'cancel');
    if (!scope) return { kind: 'denied' };
    const payload = JSON.stringify({ ...scope, ...extra });
    const result = await rpc!('signup_phone_transition', `phoneproof.${action}.${payload}`, { p_action: action, p_payload: payload }) as Record<string, unknown>;
    if (!result || typeof result.kind !== 'string' || !outcomes.has(result.kind)) return { kind: 'unknown' };
    if (result.kind === 'reserved' && action === 'reserve_check') {
      const ref = result.reference as PhoneReference | undefined;
      if (!ref || ref.service !== scope.service || ref.phone !== scope.phone || !/^VE[0-9a-fA-F]{32}$/.test(ref.sid)) return { kind: 'unknown' };
      return { kind: 'reserved', reference: ref };
    }
    // An unsolicited approval cannot be returned by a reservation or cancellation response.
    if (result.kind === 'approved' && action !== 'finish_check') return { kind: 'denied' };
    return { kind: result.kind } as SignupPhoneOutcome | Reservation;
  };
  const run = async (action: 'send' | 'check', p: SignupProgress, code = ''): Promise<SignupPhoneOutcome> => {
    if (!provider || !rpc) return { kind: 'disabled' };
    if (!binding(p) || (action === 'check' && !/^\d{6}$/.test(code))) return { kind: 'denied' };
    const operation = crypto.randomUUID();
    try {
      const reserved = await transition(`reserve_${action}`, p, { operation });
      if (reserved.kind !== 'reserved') return reserved;
      let response: PhoneProviderOutcome;
      try { response = action === 'send' ? await provider.start(p.phone!) : await provider.check(reserved.reference!, code); }
      catch { response = { kind: 'unknown' }; }
      const ref = 'reference' in response ? response.reference : undefined;
      const matches = ref?.phone === p.phone && ref?.service === provider.service && /^VE[0-9a-fA-F]{32}$/.test(ref.sid)
        && (action !== 'check' || ref.sid === reserved.reference!.sid);
      const outcome = ref && !matches ? 'unknown' : response.kind;
      const result = await transition(`finish_${action}`, p, { operation, outcome, sid: matches ? ref!.sid : '' });
      return result.kind === 'reserved' ? { kind: 'unknown' } : result;
    } catch { return { kind: 'unknown' }; } // Reservation remains durable; uncertain effects are never retried automatically.
  };
  return {
    start: p => run('send', p),
    check: (p, code) => run('check', p, code),
    async cancel(p) {
      if (!provider || !rpc) return { kind: 'disabled' };
      try { const result = await transition('cancel', p); return result.kind === 'reserved' ? { kind: 'unknown' } : result; }
      catch { return { kind: 'unknown' }; }
    },
  };
};
