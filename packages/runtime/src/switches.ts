// Feature switches and tuning knobs travel as one JSON var, WALDO_SWITCHES, because Cloudflare caps a Worker's text bindings
// (vars and secrets together) at 128 and every switch was one more. Each entry seam (the Worker's fetch, email and scheduled
// handlers and each Durable Object's constructor) passes its env through withSwitches, so code below a seam reads
// env.<NAME> as it did when every switch was its own var. A name set on env itself wins, so a test's override or a deploy's
// --var still applies. guard-switches-binding.mjs checks that every seam does this.
//
// A WALDO_SWITCHES that is not a JSON object of strings throws at the seam: every request and object fails loudly rather
// than running with every switch read as off. One that is absent (the PR preview) leaves env as it is.
const flattened = new WeakMap<object, object>();
const seen = new WeakSet<object>();

const switchesOf = (raw: unknown): Record<string, string> | undefined => {
  if (raw === undefined) return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { throw new Error('WALDO_SWITCHES is not valid JSON'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((switchValue) => typeof switchValue !== 'string')) {
    throw new Error('WALDO_SWITCHES must be a JSON object of string values');
  }
  return value as Record<string, string>;
};

export const withSwitches = <E extends object>(env: E): E => {
  if (seen.has(env)) return env;
  const cached = flattened.get(env);
  if (cached) return cached as E;
  const switches = switchesOf((env as { WALDO_SWITCHES?: unknown }).WALDO_SWITCHES);
  const flat = (switches ? { ...switches, ...env } : env) as E;
  flattened.set(env, flat);
  seen.add(flat);
  return flat;
};
