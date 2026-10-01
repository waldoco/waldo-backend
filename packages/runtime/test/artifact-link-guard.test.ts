import { describe, expect, it } from 'vitest';
import { buildSessionState, getContextArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema } from '@waldo/contracts';
import { runToolLoop } from '../src/conversation/tool-loop';
import { ARTIFACT_LINK_REMOVED_NOTICE } from '../src/conversation/artifact-link-guard';
import { resolveRunLoopAdapters } from '../src/run-loop/adapters';

// Layer: tool-loop with a scripted model step and a stub create_artifact handler (synthetic ids and
// hosts). It checks the deterministic final-reply guard only; the real artifact book, the delivery
// route and a live model are not exercised.
const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const ctx = {
  authenticatedUserId: 'owner-1', trigger: 'user_message' as const, canaryTokens: CANARIES,
  sourceTaint: null, toolArgSourceTaint: null,
  sanitise: adapters.safety.sanitise, medicalGate: adapters.safety.medicalGate,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: 0 }),
};
const allow = triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('create_artifact'));
const stub = (data: unknown) => [{
  name: 'create_artifact', description: 'stub', schema: getContextArgsSchema, trigger_allowlist: allow,
  autonomy_gated: false, mutates_state: true,
  handle: async () => ({ ok: true as const, data, source_taint: null }),
}];
const call = { call_id: 'c1', name: 'create_artifact', arguments: '{}' };
const MADE_UP = 'https://files.example.test/artifacts/art:a304fb9e';
const run = async (data: unknown, reply: string, withCall = true) => {
  let first = true;
  return runToolLoop({
    handlers: stub(data) as never, ctx, maxSteps: 4,
    step: async () => { if (withCall && first) { first = false; return { text: '', tool_calls: [call] }; } return { text: reply }; },
  });
};
const internal = { artifact_id: 'art:a304fb9e', revision: 1, delivery: { status: 'saved_internal', url: null, audience: 'unverified' } };

describe('artifact delivery link receipt guard', () => {
  it('removes an artifact URL composed from an internal id when the tool returned no URL', async () => {
    const text = await run(internal, `Saved it. Here it is: ${MADE_UP} - take a look.`);
    expect(text).not.toContain('files.example.test');
    expect(text).toContain('Saved it.');
    expect(text).toContain(ARTIFACT_LINK_REMOVED_NOTICE);
  });
  it('keeps the exact URL that a successful current-turn receipt returned', async () => {
    const url = 'https://files.example.test/d/xyz789';
    const text = await run({ ...internal, delivery: { status: 'delivered', url, audience: 'owner' } }, `Done: ${url}`);
    expect(text).toBe(`Done: ${url}`);
  });
  it('removes a URL that differs from the receipt URL', async () => {
    const url = 'https://files.example.test/artifacts/art:a304fb9e/v1';
    const text = await run({ ...internal, delivery: { status: 'delivered', url, audience: 'owner' } }, `Done: ${url}x and ${MADE_UP}`);
    expect(text).not.toContain('files.example.test');
    expect(text).toContain(ARTIFACT_LINK_REMOVED_NOTICE);
  });
  it('does not treat a URL in other tool result text as a receipt', async () => {
    const text = await run({ ...internal, note: `see ${MADE_UP}` }, `Link: ${MADE_UP}`);
    expect(text).not.toContain('files.example.test');
  });
  it('removes a percent-encoded artifact URL with no receipt', async () => {
    const text = await run(internal, 'Link: https://files.example.test/artifacts/art%3Aa304fb9e');
    expect(text).not.toContain('files.example.test');
  });
  it('a reply with no tool call this turn cannot carry an artifact URL from earlier history', async () => {
    const text = await run(internal, `Earlier link: ${MADE_UP}`, false);
    expect(text).not.toContain('files.example.test');
  });
  it('leaves ordinary URLs and text without URLs unchanged', async () => {
    const text = await run(internal, 'See https://example.com/page and the weather. Saved internally as art:a304fb9e.');
    expect(text).toBe('See https://example.com/page and the weather. Saved internally as art:a304fb9e.');
  });
});
