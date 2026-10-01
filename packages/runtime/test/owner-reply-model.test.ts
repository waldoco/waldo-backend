import { it, expect, vi } from 'vitest';
const seen = vi.hoisted(() => ({ models: [] as string[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  const b = body as { model: string; text?: { format?: { type: string } } };
  const writer = b.text?.format?.type === 'json_schema';
  if (!writer) seen.models.push(b.model);
  return { id: 'fixture', output_text: writer ? '{}' : 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const replyModel = async (text: string): Promise<string> => {
  seen.models = [];
  const responder = createOwnerResponder('fixture', undefined, undefined);
  await responder.respond({ traceId: `t-${text}`, conversationRef: 'owner', surface: 'telegram', text }, (_name, work) => work());
  return seen.models[0]!;
};
it('reply model is chosen by the host, never by pattern-matching the owner text', async () => {
  expect(await replyModel('yes')).toBe(await replyModel('Plan my Friday around the dentist'));
});
