import { iMessageComposition, type IMessageBridgeDO, type IMessageEnv } from './bridge-do';
import { iMessageDirectory, type EnrollmentContext } from './directory';
import { photonConfig, photonDoName, photonEnroll, photonPersonName, photonRemove } from './photon';

// Enrolling an owner's iPhone number with Photon, so the shared Waldo number's pool lets it text Waldo. Enrollment
// links no one: the number reaches the owner's Waldo only after "waldo CODE" arrives from it.

export type EnrollOutcome =
  | { kind: 'enrolled'; number: string }
  | { kind: 'disabled' } | { kind: 'invalid' } | { kind: 'photon_disconnected' } | { kind: 'phone_taken' } | { kind: 'refused' } | { kind: 'unknown' };

const E164 = /^\+[1-9]\d{6,14}$/;
export const normalizePhone = (raw: unknown): string | null => {
  const compact = typeof raw === 'string' ? raw.replace(/[\s().-]/g, '') : '';
  return E164.test(compact) ? compact : null;
};

function photonObject(env: IMessageEnv, environment: string) {
  const ns = env.IMESSAGE_BRIDGE_DO as unknown as DurableObjectNamespace<IMessageBridgeDO>;
  return ns.get(ns.idFromName(photonDoName(environment)));
}

export async function enrollOwner(env: IMessageEnv, owner: string, rawPhone: unknown): Promise<EnrollOutcome> {
  const c = iMessageComposition(env), config = photonConfig(env);
  if (!c || !config) return { kind: 'disabled' };
  const phone = normalizePhone(rawPhone);
  if (!phone) return { kind: 'invalid' };
  const directory = iMessageDirectory(env);
  try {
    const context = await directory.enrollmentRead(owner, c.environment);
    if (!context) return { kind: 'refused' };
    // Find-or-create runs even for the same number: a Photon user removed meanwhile is made again.
    const photon = photonObject(env, c.environment), person = { phone, email: context.email, ...photonPersonName(context.email) };
    let token = await photon.photonAccessToken();
    if (!token) return { kind: 'photon_disconnected' };
    let user = await photonEnroll(config, token, person);
    if ('error' in user && user.error === 'unauthorized') {
      // A cached access token Photon no longer honours: refresh once.
      await photon.photonDropAccess();
      token = await photon.photonAccessToken();
      if (!token) return { kind: 'photon_disconnected' };
      user = await photonEnroll(config, token, person);
    }
    if ('error' in user) return user.error === 'refused' ? { kind: 'refused' } : { kind: 'photon_disconnected' };
    const recorded = await directory.enrollmentRecord(owner, c.environment, phone, user.userId, user.assignedNumber, user.created);
    if (recorded.result !== 'recorded') return { kind: recorded.result === 'phone_taken' ? 'phone_taken' : 'refused' };
    if (recorded.release) await photonRemove(config, token, recorded.release);
    return { kind: 'enrolled', number: user.assignedNumber };
  } catch { return { kind: 'unknown' }; }
}

/**
 * What the console shows for iMessage. With Photon configured, an owner texts their own assigned number and must
 * enroll first; without it, everyone texts the one configured address.
 */
export type IMessageNumberView = Readonly<{ number: string | null; phone: string | null; enrollable: boolean }>;
export async function iMessageNumberView(env: IMessageEnv, owner: string): Promise<IMessageNumberView> {
  const c = iMessageComposition(env);
  if (!c || !photonConfig(env)) return { number: env.IMESSAGE_WALDO_ADDRESS || null, phone: null, enrollable: false };
  const context: EnrollmentContext | null = await iMessageDirectory(env).enrollmentRead(owner, c.environment);
  return { number: context?.enrollment?.assignedNumber ?? null, phone: context?.enrollment?.phone ?? context?.phone ?? null, enrollable: !!context };
}

/** Operator view of the Photon connection; null when Photon is not configured. */
export async function photonConnection(env: IMessageEnv): Promise<'connected' | 'disconnected' | null> {
  const c = iMessageComposition(env);
  if (!c || !photonConfig(env)) return null;
  const status = await photonObject(env, c.environment).photonStatus();
  return status?.connected ? 'connected' : 'disconnected';
}

/** Starts the operator's Photon sign-in; the caller binds the browser and redirects to the returned URL. */
export async function photonConnectStart(env: IMessageEnv, owner: string, origin: string, callbackPath: string): Promise<{ nonce: string; url: string } | null> {
  const c = iMessageComposition(env);
  if (!c || !photonConfig(env)) return null;
  return photonObject(env, c.environment).photonBegin(owner, `${origin}${callbackPath}`);
}

export const photonConnectFinish = async (env: IMessageEnv, nonce: string, query: string) => {
  const c = iMessageComposition(env);
  return c && photonConfig(env) ? photonObject(env, c.environment).photonFinish(nonce, query) : 'failed' as const;
};

export const photonKeepAlive = async (env: IMessageEnv) => {
  const c = iMessageComposition(env);
  return c && photonConfig(env) ? photonObject(env, c.environment).photonKeepAlive() : 'unconfigured' as const;
};
