import { describe, expect, it } from 'vitest';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';

// The Form curve switch is declared, off, for production and for staging until an independent privacy review passes.
type Vars = Readonly<Record<string, string>>;
const parsed = parseJsonc(config) as { vars: Vars; env: Record<string, { vars: Vars }> };

describe('HEALTH_FORM_CURVE in the Worker config', () => {
  it('is declared off for production and for every environment', () => {
    expect(parsed.vars.HEALTH_FORM_CURVE).toBe('0');
    for (const [name, environment] of Object.entries(parsed.env)) expect(environment.vars.HEALTH_FORM_CURVE, name).toBe('0');
  });
  it('leaves the provisional switch as it was', () => {
    expect(parsed.vars.HEALTH_PROVISIONAL_SCORES).toBe('0');
    expect(parsed.env.staging!.vars.HEALTH_PROVISIONAL_SCORES).toBe('1');
  });
});
