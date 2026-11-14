// A wrangler vars block as the Worker reads it: the switches nested under WALDO_SWITCHES become top-level names, and a name
// declared directly wins, as packages/runtime/src/switches.ts flattens them at every entry seam.
export const flatVars = (vars) => {
  const { WALDO_SWITCHES: switches, ...rest } = vars ?? {};
  return switches && typeof switches === 'object' ? { ...switches, ...rest } : { ...rest };
};

// A parsed wrangler.jsonc with every vars block (top level and each environment) flattened.
export const flatConfig = (config) => ({
  ...config,
  vars: flatVars(config?.vars),
  env: Object.fromEntries(Object.entries(config?.env ?? {}).map(([name, block]) => [name, { ...block, vars: flatVars(block?.vars) }])),
});
