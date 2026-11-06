// Feature switches and tuning knobs travel as one JSON var, WALDO_SWITCHES, because Cloudflare caps a Worker's text bindings
// (vars and secrets together) at 128 and every switch was one more. Each entry seam (the Worker's fetch, email and scheduled
// handlers and each Durable Object's constructor) passes its env through withSwitches, so code below a seam reads
// env.<NAME> as it did when every switch was its own var. A name set on env itself wins, so a test's override or a deploy's
// --var still applies. guard-switches-binding.mjs checks that every seam does this.
const flattened = new WeakMap<object, object>();
const seen = new WeakSet<object>();

export const withSwitches = <E extends object>(env: E): E => {
  if (seen.has(env)) return env;
  const cached = flattened.get(env);
  if (cached) return cached as E;
  const switches = (env as { WALDO_SWITCHES?: unknown }).WALDO_SWITCHES;
  const flat = (switches && typeof switches === 'object' ? { ...switches, ...env } : env) as E;
  flattened.set(env, flat);
  seen.add(flat);
  return flat;
};
