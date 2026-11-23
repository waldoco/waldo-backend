import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';
import { flatVars } from '../../../scripts/wrangler-vars.mjs';
import { SHIPPED_SWITCHES, declaredSwitch, withSwitches } from '../src/switches';

describe('withSwitches', () => {
  it('gives the Worker every var wrangler.jsonc declares, by name and value, the switches flattened out of WALDO_SWITCHES', () => {
    // The test pool loads the top-level (production) vars, and sets a few names flat itself (vitest.config.ts), which win.
    const declared = flatVars((parseJsonc(config) as { vars: Record<string, unknown> }).vars);
    const raw = env as unknown as Record<string, unknown>, read = withSwitches(env) as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(declared)) expect([name, read[name]]).toEqual([name, name in raw ? raw[name] : value]);
    expect(Object.keys(declared).length).toBeGreaterThan(100);
    expect([declared.WHATSAPP_QUIET_MS, read.WHATSAPP_QUIET_MS]).toEqual(['3000', '0']);
  });

  it('lets a name set on env win, reads a changed env afresh, and leaves an env without switches as it is', () => {
    const raw: Record<string, unknown> = { WALDO_SWITCHES: { DEVICE_PLACE: '1', WALDO_OWNER_FIRST: '0' }, WALDO_OWNER_FIRST: '1', OTHER: 'x' };
    const flat = withSwitches(raw) as Record<string, unknown>;
    expect([flat.DEVICE_PLACE, flat.WALDO_OWNER_FIRST, flat.OTHER]).toEqual(['1', '1', 'x']);
    expect(withSwitches(flat)).toEqual(flat);
    raw.DEVICE_PLACE = '0';
    expect((withSwitches(raw) as Record<string, unknown>).DEVICE_PLACE).toBe('0');
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

describe('declaredSwitch', () => {
  it('reads a declared switch, reads a shipped one as on once it is no longer declared, and reads nothing else', () => {
    expect(SHIPPED_SWITCHES.has('DEVICE_PLACE')).toBe(true);
    expect(declaredSwitch({ WALDO_SWITCHES: { DEVICE_PLACE: '0' } }, 'DEVICE_PLACE')).toBe('0');
    expect(declaredSwitch({ WALDO_SWITCHES: { MEDICATIONS: '0' } }, 'DEVICE_PLACE')).toBe('1');
    expect(declaredSwitch({}, 'DEVICE_PLACE')).toBe('1');
    expect(declaredSwitch({ WALDO_SWITCHES: { MEDICATIONS: '0' }, OPENAI_API_KEY: 'sk' }, 'OPENAI_API_KEY')).toBeUndefined();
    expect(declaredSwitch({ WALDO_SWITCHES: {} }, 'MEDICATIONS')).toBeUndefined();
  });
});
