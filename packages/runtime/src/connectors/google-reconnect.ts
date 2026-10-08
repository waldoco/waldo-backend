import { googleHas, GoogleError, type GoogleClient } from './google';

// One reconnect notice per failure episode. The notice fires on the healthy -> failing
// transition while no notice is outstanding; while the grant keeps failing the circuit breaker
// (google-circuit.ts) owns retries and the notice stays silent; recovery clears the outstanding
// record and re-arms the episode. The caller records the notice only once it was delivered.
export const reauthNoticeTransition = (
  state: Readonly<{ failing: boolean; noticed: boolean }>,
  error: string,
): Readonly<{ send: boolean; noticed: boolean }> =>
  error === ''
    ? { send: false, noticed: false }
    : { send: !state.failing && !state.noticed, noticed: state.noticed };

// The confirmation read after a connect or reconnect: one real provider round trip on the new
// grant, on the cheapest feature the grant covers. Legacy null-scope grants retain the old
// features (googleHas), so they confirm on calendar like a full consent grant.
export type GoogleReadbackFeature = 'calendar' | 'mail' | 'tasks';
export const readbackFeature = (scopes: readonly string[] | null | undefined): GoogleReadbackFeature | null =>
  (['calendar', 'mail', 'tasks'] as const).find((feature) => googleHas(scopes, feature)) ?? null;

export class GoogleReadbackError extends Error {
  constructor(readonly kind: 'auth' | 'transient' | 'unavailable', message: string) {
    super(message);
    this.name = 'GoogleReadbackError';
  }
}

// Readback-confirmed recovery: "Google is connected" is claimed only after this read succeeds on
// the freshly stored grant. A readback failure settles the consent attempt as failed instead of
// telling the owner the account works; the provider's 401 classifies the failure as auth (the
// reconnect did not fix the grant), anything else as transient.
export const confirmGoogleReadback = async (client: GoogleClient, feature: GoogleReadbackFeature, now: number): Promise<void> => {
  try {
    if (feature === 'calendar') await client.events(new Date(now).toISOString(), new Date(now + 3_600_000).toISOString(), 1, false);
    else if (feature === 'mail') await client.newMail(now, 1);
    else await client.tasks('todo', 1);
  } catch (error) {
    if (error instanceof GoogleError && error.status === 401) throw new GoogleReadbackError('auth', 'the fresh grant failed its confirmation read');
    throw new GoogleReadbackError('transient', error instanceof Error ? error.message : String(error));
  }
};
