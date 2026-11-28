// ADR-0085 D6: anything derived from the owner's cycle leaves only through their own app. Every send to another surface
// (WhatsApp, Telegram, iMessage, email, push) passes through offAppPayload first, in code, whatever wrote the payload.
//
// - Removed wherever they sit: the cycle basis (an object whose kind is cycle_phase, or a reading_basis key) and the Cycle row's
//   fields. The rest of the payload, symbol keys included, is passed on unchanged.
// - A payload that cannot be walked (a reference loop, nesting past MAX_DEPTH, a value that throws when read) gives null, and the
//   caller drops the send rather than sending it unchecked.
// Free text is not judged here: the model never receives a cycle date or basis, so no cycle field can reach the words it writes.
const CYCLE_KEYS: ReadonlySet<string> = new Set(['reading_basis', 'cycle_phase', 'cycle_context', 'last_period_start', 'last_source_name']);
const MAX_DEPTH = 32;

const isCycleBasis = (value: unknown): boolean => !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'cycle_phase';

const strip = (value: unknown, depth: number, seen: Set<object>): unknown => {
  if (!value || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH || seen.has(value)) throw new Error('payload cannot be walked');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.filter(entry => !isCycleBasis(entry)).map(entry => strip(entry, depth + 1, seen));
    const out: Record<PropertyKey, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      const entry = (value as Record<PropertyKey, unknown>)[key];
      if (typeof key === 'string' && CYCLE_KEYS.has(key)) continue;
      if (isCycleBasis(entry)) continue;
      out[key] = strip(entry, depth + 1, seen);
    }
    return out;
  } finally { seen.delete(value); }
};

export const offAppPayload = <T>(payload: T): T | null => {
  try { return strip(payload, 0, new Set()) as T; } catch { return null; }
};

// An outbox route to a surface other than the app: a record whose payload cannot be stripped is never allowed, so the outbox
// blocks it, and what is sent is always the stripped payload.
type Route<R, P> = { allowed(record: R): Promise<boolean>; send(payload: P, record: R): Promise<unknown> };
export const offAppRoute = <R extends { payload: P }, P, T extends Route<R, P>>(inner: T): T => ({
  ...inner,
  allowed: async (record: R) => offAppPayload(record.payload) !== null && inner.allowed(record),
  send: async (payload: P, record: R) => {
    const clean = offAppPayload(payload);
    if (clean === null) throw new Error('off-app payload refused');
    return inner.send(clean, record);
  },
});
