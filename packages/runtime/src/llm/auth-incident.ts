import type { Provider } from '@waldo/contracts';
import type { LLMAttempt } from './provider';

type Kv = Pick<DurableObjectStorage['kv'], 'get' | 'put'>;
const KEY = 'model_auth_incidents_v1';

export type ModelAuthIncident = Readonly<{ provider: Provider; since: number }>;

// A provider that refuses the key stays refused until someone replaces it, so its refusals are one incident: the first opens
// it and is told, the rest stay quiet, and the next call that provider answers closes it. A refusal the fallback provider
// covered still counts. Returns the incidents this call opened.
export function observeModelAuth(kv: Kv, attempts: readonly LLMAttempt[], now: number): readonly ModelAuthIncident[] {
  const open: Partial<Record<Provider, number>> = { ...(kv.get<Partial<Record<Provider, number>>>(KEY) ?? {}) };
  const opened: ModelAuthIncident[] = [];
  let changed = false;
  for (const attempt of attempts) {
    if (attempt.outcome === 'success' && open[attempt.provider] !== undefined) {
      delete open[attempt.provider];
      changed = true;
    } else if (attempt.outcome === 'failure' && attempt.code === 'auth_failed' && open[attempt.provider] === undefined) {
      open[attempt.provider] = now;
      opened.push({ provider: attempt.provider, since: now });
      changed = true;
    }
  }
  if (changed) kv.put(KEY, open);
  return opened;
}
