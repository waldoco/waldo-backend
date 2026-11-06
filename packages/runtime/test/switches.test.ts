import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';
import { flatVars } from '../../../scripts/wrangler-vars.mjs';
import { withSwitches } from '../src/switches';

describe('withSwitches', () => {
  it('gives the Worker every var wrangler.jsonc declares, by name and value, the switches flattened out of WALDO_SWITCHES', () => {
    // The test pool loads the top-level (production) vars, and sets a few names flat itself (vitest.config.ts), which win.
    const declared = flatVars((parseJsonc(config) as { vars: Record<string, unknown> }).vars);
    const raw = env as unknown as Record<string, unknown>, read = withSwitches(env) as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(declared)) expect([name, read[name]]).toEqual([name, name in raw ? raw[name] : value]);
    expect(Object.keys(declared).length).toBeGreaterThan(100);
    expect([declared.WHATSAPP_QUIET_MS, read.WHATSAPP_QUIET_MS]).toEqual(['3000', '0']);
  });

  it('lets a name set on env win, keeps the flattened env stable, and leaves an env without switches as it is', () => {
    const raw = { WALDO_SWITCHES: { DEVICE_PLACE: '1', WALDO_OWNER_FIRST: '0' }, WALDO_OWNER_FIRST: '1', OTHER: 'x' };
    const flat = withSwitches(raw) as typeof raw & Record<string, string>;
    expect([flat.DEVICE_PLACE, flat.WALDO_OWNER_FIRST, flat.OTHER]).toEqual(['1', '1', 'x']);
    expect(withSwitches(raw)).toBe(flat);
    expect(withSwitches(flat)).toBe(flat);
    const preview = { WALDO_ENVIRONMENT: 'preview' };
    expect(withSwitches(preview)).toBe(preview);
    expect(withSwitches({ WALDO_SWITCHES: '{"DEVICE_PLACE":"1"}' }) as Record<string, unknown>).toMatchObject({ DEVICE_PLACE: '1' });
  });

  it('throws on a WALDO_SWITCHES that is not a JSON object of strings, so nothing runs with every switch read as off', () => {
    for (const bad of ['{"DEVICE_PLACE":', '[]', 'null', '"on"', ['1'], { DEVICE_PLACE: 1 }, { DEVICE_PLACE: true }, null, 7]) {
      expect(() => withSwitches({ WALDO_SWITCHES: bad }), JSON.stringify(bad)).toThrow(/WALDO_SWITCHES/);
    }
  });
});
