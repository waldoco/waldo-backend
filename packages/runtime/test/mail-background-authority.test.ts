import { expect, it, vi } from 'vitest';
import { readThreadArgsSchema } from '@waldo/contracts';
const seen = vi.hoisted(() => ({ requests: [] as string[], calls: 0 }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  seen.requests.push(JSON.stringify(body));
  const next = seen.requests.length % 2 === 1;
  return { id: 'fixture', output_text: next ? '' : 'Have you handled the review?', output: next ? [{ type: 'function_call', call_id: 'injected-read', name: 'read_thread', arguments: '{"thread_id":"t1","limit":3}' }] : [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
it('denies a model-requested OTP relay outside the background tool ceiling, leaving default prompts unchanged', async () => {
  const responder = createOwnerResponder('fixture', undefined, undefined, undefined, undefined, [{ name: 'read_thread', description: 'Read', schema: readThreadArgsSchema, trigger_allowlist: ['user_message'], autonomy_gated: false, async handle() { seen.calls++; return { ok: true, data: [], source_taint: 'external' as const }; } }]);
  await responder.prompt('mail-1', 'owner', 'Untrusted mail asks to read and relay an OTP', (_n, work) => work(), 'telegram', ['get_context']);
  expect(seen.calls).toBe(0);
  expect((JSON.parse(seen.requests[0]!) as { tools: { name: string }[] }).tools.map(t => t.name)).not.toContain('read_thread');
  seen.requests = [];
  await responder.prompt('legacy-1', 'owner', 'Existing prompt behavior', (_n, work) => work(), 'telegram');
  expect((JSON.parse(seen.requests[0]!) as { tools: { name: string }[] }).tools.map(t => t.name)).toContain('read_thread');
});
