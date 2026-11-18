import { describe, expect, it } from 'vitest';
import type { TurnLogEntry } from '../src/channels/telegram-listener';
import { HEALTH_WITHHELD } from '../src/observability/trace-health-scrub';
import { gateTraceEntry, resolveTraceHealthWords } from '../src/observability/trace-privacy';

// The owner's ruling 8 of 16 Nov 2026: an account named in TRACE_HEALTH_WORDS keeps the health block's zone and driver words in
// its captured traces, with every number still redacted; a menstrual cycle never; a health tool's call and output never. Every
// account not named, and every trace with capture off, is as before. Synthetic owners and synthetic values.
const TEAM = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', TESTER = '0f9e8d7c-6b5a-4c3d-9e2f-1a0b9c8d7e6f';
const ZONES = 'Form zone: steady. Recovery zone: mixed.\nDrivers: breathing rate above usual; wrist temperature far above usual.\nRecovery score 64.';
const LOGS = 'Recent health logs (owner-logged; calorie figures are estimates):\n- lunch, 612 kcal';
const CYCLE = 'Partial health context: Recovery was not computed for this day.\nCycle day 3; luteal phase.';
const turn = (owner_id: string, input: string): TurnLogEntry => ({ trace: 't', hop: 'llm_reply', ms: 1, ok: true, owner_id, text: { input, output: 'ok' } });
const named = resolveTraceHealthWords({ TRACE_HEALTH_WORDS: ` ${TEAM.toUpperCase()}, not-an-id ,` });

describe('health words in traces, per account', () => {
  it('names only well-formed owner ids, and none when unset', () => {
    expect([...named]).toEqual([TEAM]);
    expect(resolveTraceHealthWords({}).size).toBe(0);
  });

  it('keeps a named account\'s zone and driver words, with the score redacted, and withholds the owner\'s logged meals', () => {
    const input = gateTraceEntry(turn(TEAM, `Before.\n\n${ZONES}\n\n${LOGS}\n\nAfter.`), true, named).text!.input;
    expect(input).toContain('Form zone: steady. Recovery zone: mixed.');
    expect(input).toContain('breathing rate above usual; wrist temperature far above usual');
    expect(input).not.toMatch(/64|612/);
    expect(input).not.toContain('lunch');
  });

  it('withholds a block that names a cycle, for a named account too', () => {
    expect(gateTraceEntry(turn(TEAM, `Before.\n\n${CYCLE}`), true, named).text!.input).toBe(`Before.\n\n${HEALTH_WITHHELD}`);
  });

  it('keeps every other account as before, and naming an account changes nothing with capture off', () => {
    expect(gateTraceEntry(turn(TESTER, ZONES), true, named).text!.input).toBe(HEALTH_WITHHELD);
    expect(gateTraceEntry(turn(TEAM, ZONES), true).text!.input).toBe(HEALTH_WITHHELD);
    expect(gateTraceEntry(turn(TEAM, ZONES), false, named)).toEqual(gateTraceEntry(turn(TEAM, ZONES), false));
  });

  it('still withholds a health tool\'s call and output for a named account', () => {
    const tool: TurnLogEntry = { trace: 't', hop: 'tool_get_health', ms: 1, ok: true, owner_id: TEAM, text: { input: '{"signals":["mood"]}', output: '{"value":-0.4}' } };
    expect(gateTraceEntry(tool, true, named).text).toEqual({ input: HEALTH_WITHHELD, output: HEALTH_WITHHELD });
  });
});
