// Node-only pinned-SDK protocol fixture. No account or network access.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export const env = globalThis.__fixtureWorkerEnv;', shortCircuit: true };
  return nextResolve(specifier, context);
}
