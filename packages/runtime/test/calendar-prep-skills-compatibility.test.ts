import { expect, it } from 'vitest';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { CALENDAR_PREP_FORMAT } from '../src/channels/event-briefs';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';

it('transient prep never loads or reuses an earlier owner skill procedure or its revoked capability', async () => {
  const body = 'Reviewed owner-only preparation procedure';
  const requests: LLMGatewayRequest[] = [];
  let revoked = false;
  let promptCalls = 0;
  let metadataCalls = 0;
  let currentCalls = 0;
  const gateway: LLMGatewayAdapter = { complete: async request => {
    requests.push(request);
    return { ok: true, data: { model: request.request.model, text: request.request.response_format?.name === 'calendar_prep' ? '{"kind":"no_op","text":""}' : 'Prepared for the owner.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[10] = gateway;
  args[21] = { skills: { handlers: [], metadata: () => { metadataCalls++; return 'Reviewed owner skill metadata'; }, prompt: async () => { promptCalls++; return body; }, assertProcedureCurrent: async expected => { currentCalls++; if (revoked || expected !== body) throw new Error('owner skill revoked'); } } };
  const responder = createOwnerResponder(...args);
  const time = <T>(_hop: string, work: () => Promise<T>) => work();
  await responder.respond({ traceId: 'owner-skill', conversationRef: 'owner', surface: 'telegram', text: 'Prepare my document', memoryWrites: false }, time);
  expect(requests[0]!.request.system).toContain(body);
  expect(currentCalls).toBeGreaterThan(0);
  const before = { promptCalls, metadataCalls, currentCalls };
  revoked = true;
  await expect(responder.prompt('calendar-transient', 'owner', '[Meeting prep decision] Calendar facts only', time, 'telegram', [], async () => undefined, CALENDAR_PREP_FORMAT)).resolves.toBe('{"kind":"no_op","text":""}');
  const prep = requests.at(-1)!;
  expect(prep.request.system).not.toContain(body);
  expect(prep.request.system).not.toContain('Reviewed owner skill metadata');
  expect(prep.request.tools ?? []).toEqual([]);
  expect({ promptCalls, metadataCalls, currentCalls }).toEqual(before);
});
