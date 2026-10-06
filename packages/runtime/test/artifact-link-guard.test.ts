import { describe, expect, it } from 'vitest';
import { buildSessionState, createArtifactArgsSchema, readArtifactArgsSchema, reviseArtifactArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema } from '@waldo/contracts';
import { runToolLoop } from '../src/conversation/tool-loop';
import { ARTIFACT_LINK_REMOVED_NOTICE, receiptUrl } from '../src/conversation/artifact-link-guard';
import { resolveRunLoopAdapters } from '../src/run-loop/adapters';

// Layer: tool-loop with a scripted model step and a stub create_artifact handler (synthetic ids and
// hosts). It checks the deterministic final-reply guard only; the real artifact book, the delivery
// route and a live model are not exercised.
const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const ctx = {
  authenticatedUserId: 'owner-1', trigger: 'user_message' as const, canaryTokens: CANARIES,
  sourceTaint: null, toolArgSourceTaint: null,
  sanitise: adapters.safety.sanitise,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: 0 }),
};
const allow = (name: string) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name as never));
const ARGS: Record<string, Record<string, unknown>> = {
  create_artifact: { name: 'Brief', kind: 'document', body_markdown: 'body' },
  revise_artifact: { artifact_id: 'art:a304fb9e', expected_revision: 1, body_markdown: 'body' },
  read_artifact: { artifact_id: 'art:a304fb9e' },
};
const SCHEMAS: Record<string, never> = { create_artifact: createArtifactArgsSchema, revise_artifact: reviseArtifactArgsSchema, read_artifact: readArtifactArgsSchema } as never;
const stub = (name: string, data: unknown, taint: 'external' | null) => [{
  name, description: 'stub', schema: SCHEMAS[name], trigger_allowlist: allow(name),
  autonomy_gated: false, mutates_state: true,
  handle: async () => ({ ok: true as const, data, source_taint: taint }),
}];
const MADE_UP = 'https://files.example.test/artifacts/art:a304fb9e';
const URL = 'https://files.example.test/artifacts/art:a304fb9e/d/xyz789';
const internal = { artifact_id: 'art:a304fb9e', revision: 1, delivery: { status: 'saved_internal', url: null, audience: 'unverified' } };
const owned = { ...internal, delivery: { status: 'owner_link', url: URL, audience: 'owner_authenticated' } };
type Opts = { name?: string; withCall?: boolean };
const run = async (data: unknown, reply: string, { name = 'create_artifact', withCall = true }: Opts = {}) => {
  let first = true;
  const calls: string[] = [];
  const text = await runToolLoop({
    handlers: stub(name, data, null) as never, ctx, maxSteps: 4,
    onTool: (event) => calls.push(`${event.call.name}:${event.ok}${event.error ? `:${event.error}` : ''}`),
    step: async () => { if (withCall && first) { first = false; return { text: '', tool_calls: [{ call_id: 'c1', name, arguments: JSON.stringify(ARGS[name]) }] }; } return { text: reply }; },
  });
  // Every scripted tool call must really succeed, or a pass/fail below would be vacuous.
  if (withCall) expect(calls).toEqual([`${name}:true`]);
  return text;
};
const gone = (text: string) => expect(text).not.toContain('files.example.test');

describe('artifact delivery link receipt guard', () => {
  it('removes an artifact URL composed from an internal id when the tool returned no URL', async () => {
    const text = await run(internal, `Saved it. Here it is: ${MADE_UP} - take a look.`);
    gone(text);
    expect(text).toContain('Saved it.');
    expect(text).toContain(ARTIFACT_LINK_REMOVED_NOTICE);
  });
  it('keeps the exact owner_link URL a successful create_artifact receipt returned, trailing punctuation aside', async () => {
    expect(await run(owned, `Done: ${URL}.`)).toBe(`Done: ${URL}.`);
  });
  it('also trusts a successful revise_artifact owner_link receipt', async () => {
    expect(await run(owned, `Updated: ${URL}`, { name: 'revise_artifact' })).toBe(`Updated: ${URL}`);
  });
  it('removes a URL that differs from the receipt URL', async () => {
    const text = await run(owned, `Done: ${URL}x and ${MADE_UP}`);
    gone(text);
    expect(text).toContain(ARTIFACT_LINK_REMOVED_NOTICE);
  });
  it('does not treat a URL in other tool result text as a receipt', async () => {
    gone(await run({ ...internal, note: `see ${MADE_UP}` }, `Link: ${MADE_UP}`));
  });
  it.each([
    ['percent-encoded', 'https://files.example.test/artifacts/art%3Aa304fb9e'],
    ['double-encoded', 'https://files.example.test/artifacts/art%253Aa304fb9e'],
    ['triple-encoded', 'https://files.example.test/artifacts/art%25253Aa304fb9e'],
    ['encoded letters', 'https://files.example.test/artifacts/%61rt%3Aa304fb9e'],
    ['invalid later encoding', 'https://files.example.test/artifacts/art%3Aa304fb9e?bad=%ZZ'],
    ['invalid earlier encoding', 'https://files.example.test/%ZZ/artifacts/art:a304fb9e'],
  ])('removes a %s artifact URL with no receipt', async (_label, url) => {
    gone(await run(internal, `Link: ${url}`));
  });
  it('a reply with no tool call this turn cannot carry an artifact URL from earlier history', async () => {
    gone(await run(internal, `Earlier link: ${MADE_UP}`, { withCall: false }));
  });
  it('leaves ordinary URLs and text without URLs unchanged', async () => {
    const reply = 'See https://example.com/page and the weather. Saved internally as art:a304fb9e.';
    expect(await run(internal, reply)).toBe(reply);
  });
  // The dispatcher's own result contract already rejects these shapes (external-stamped create
  // result, read_artifact carrying delivery), so they are checked on the pure receipt function.
  it('receiptUrl never grants from read_artifact, other tools, failures or external-stamped results', () => {
    const ok = { ok: true, data: owned };
    expect(receiptUrl('create_artifact', ok)).toBe(URL);
    expect(receiptUrl('revise_artifact', ok)).toBe(URL);
    expect(receiptUrl('read_artifact', ok)).toBeNull();
    expect(receiptUrl('web_search', ok)).toBeNull();
    expect(receiptUrl('create_artifact', { ...ok, source_taint: 'external' })).toBeNull();
    expect(receiptUrl('create_artifact', { ok: false, data: owned })).toBeNull();
  });
  it.each([
    ['status saved_internal', { status: 'saved_internal', url: URL, audience: 'owner_authenticated' }],
    ['audience unverified', { status: 'owner_link', url: URL, audience: 'unverified' }],
    ['status delivered (not the contract value)', { status: 'delivered', url: URL, audience: 'owner_authenticated' }],
  ])('does not trust a receipt with %s', async (_label, delivery) => {
    gone(await run({ ...internal, delivery }, `Link: ${URL}`));
  });
});
