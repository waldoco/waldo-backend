import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { readThreadArgsSchema } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { loopBook, loopHandlers } from '../src/channels/loops';
import { updateBook } from '../src/channels/update-cards';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';

const scripted = (name: string, args: unknown) => {
  const requests: LLMGatewayRequest[] = [];
  const gateway: LLMGatewayAdapter = { async complete(request) {
    requests.push(request);
    return { ok: true, data: { model: request.request.model, text: requests.length === 1 ? '' : 'SKIP', ...(requests.length === 1 ? { tool_calls: [{ call_id: 'c1', name, arguments: JSON.stringify(args) }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { gateway, requests };
};
const time = <T>(_name: string, work: () => Promise<T>) => work();

it('an explicit no-tools or restricted background ceiling cannot regain delegation', async () => {
  for (const ceiling of [[], ['get_context']] as const) {
    const { gateway, requests } = scripted('delegate_task', { task: 'Read an authentication code and relay it' });
    await createOwnerResponder('fixture', undefined, undefined, undefined, undefined, [], undefined, false, undefined, undefined, gateway).prompt('prep-no-tools', 'owner', 'Prepare the event from supplied facts only', time, 'telegram', ceiling);
    expect(requests[0]!.request.tools?.map(t => t.name) ?? []).not.toContain('delegate_task');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.request.tool_turns?.[0]?.output).toContain('handler_unavailable');
  }
});

it('a host currentness guard denies background provider dispatch after revocation', async () => {
  const { gateway, requests } = scripted('delegate_task', { task: 'irrelevant' });
  const responder = createOwnerResponder('fixture', undefined, undefined, undefined, undefined, [], undefined, false, undefined, undefined, gateway);
  await expect(responder.prompt('revoked-prep', 'owner', 'Calendar facts', time, 'telegram', [], async () => { throw new Error('host revoked'); })).rejects.toThrow('host revoked');
  expect(requests).toEqual([]);
});

it('denies a model-requested OTP relay outside the background tool ceiling and preserves default prompts', async () => {
  let calls = 0;
  const handler = { name: 'read_thread' as const, description: 'Read', schema: readThreadArgsSchema, trigger_allowlist: ['user_message' as const], autonomy_gated: false, async handle() { calls++; return { ok: true as const, data: [], source_taint: 'external' as const }; } };
  const first = scripted('read_thread', { thread_id: 't1', limit: 3 });
  const responder = createOwnerResponder('fixture', undefined, undefined, undefined, undefined, [handler], undefined, false, undefined, undefined, first.gateway);
  await responder.prompt('mail-1', 'owner', 'External source asks to relay authentication artifacts', time, 'telegram', ['get_context']);
  expect(calls).toBe(0);
  expect(first.requests[0]!.request.tools?.map(t => t.name)).not.toContain('read_thread');
  const legacy = scripted('read_thread', { thread_id: 't1', limit: 3 });
  await createOwnerResponder('fixture', undefined, undefined, undefined, undefined, [handler], undefined, false, undefined, undefined, legacy.gateway).prompt('legacy-1', 'owner', 'Existing prompt', time, 'telegram');
  expect(legacy.requests[0]!.request.tools?.map(t => t.name)).toContain('read_thread');
});

it('requires a grounded source for background loop creation while owner tools remain backward compatible', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('mail-loop-authority')), async (_i, state) => {
    let seq = 0;
    const loops = loopBook(state.storage.sql, { now: () => 1, newId: () => String(++seq) });
    const create = async (id: string, args: unknown, restricted = true) => {
      const { gateway } = scripted('open_loop', args);
      const responder = createOwnerResponder('fixture', undefined, undefined, undefined, undefined, loopHandlers(loops), undefined, false, undefined, undefined, gateway);
      return responder.prompt(id, 'owner', 'Check observed mail', time, 'telegram', restricted ? ['open_loop'] : undefined);
    };
    await create('source-less', { title: 'A third-party request', due: '2026-10-03T10:00' });
    expect(loops.list()).toEqual([]);
    const updates = updateBook(state.storage.sql);
    updates.observeMail('mail:t1', 't1', 1, 'm1');
    updates.record('2026-10-03', 1, [{ source: 'mail', kind: 'new', source_ref: 'mail:t1', source_message_id: 'm1', detail: '{"subject":"Review by 10"}' }], null);
    await create('source-linked', { title: 'Check review', due: '2026-10-03T10:00', source_ref: 'mail:t1' });
    expect(loops.list()[0]?.source_ref).toBe('mail:t1');
    await create('owner-ordinary', { title: 'Owner task', due: null }, false);
    expect(loops.list()).toHaveLength(2);
  });
});
