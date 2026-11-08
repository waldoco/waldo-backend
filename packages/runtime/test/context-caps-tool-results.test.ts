import { ownerTyped } from './helpers/owner-typed';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { readThreadArgsSchema, triggerTypeSchema, TOOL_PERMISSIONS, type LLMToolTurn, type ToolName } from '@waldo/contracts';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { TOOL_OUTPUT_LIMIT } from '../src/conversation/tool-loop';
import { CONTEXT_BUDGET } from '../src/conversation/context-budget';

// An owner turn that reads one long thread after another, through the real responder: with WALDO_CONTEXT_CAPS the first
// clearing leaves only the latest three results; without it the turn halves its results as before.
const allowed = (name: ToolName) => triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes(name));
const ROUNDS = 12;

const clearingIn = (contextCaps: boolean) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`context-caps-results-${contextCaps}`)), async () => {
  const sent: (readonly LLMToolTurn[])[] = [];
  let step = 0;
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const reply = (text: string, call?: { name: string; arguments: string }) => ({ ok: true as const, data: { model: request.request.model, text, ...(call ? { tool_calls: [{ call_id: `c${step}`, ...call }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.request.response_format) return reply('{}');
    sent.push(request.request.tool_turns ?? []);
    step += 1;
    return step <= ROUNDS ? reply('', { name: 'read_thread', arguments: JSON.stringify({ thread_id: `thread-${step}` }) }) : reply('Read them all.');
  } };
  const mail = { name: 'read_thread' as const, description: 'Read a mail thread.', schema: readThreadArgsSchema, trigger_allowlist: allowed('read_thread'),
    handle: async () => ({ ok: true as const, data: { body: 'y'.repeat(TOOL_OUTPUT_LIMIT - 300) }, source_taint: 'external' as const }) };
  const responder = createOwnerResponder({ openaiApiKey: 'fixture', ...(contextCaps ? { contextCaps: { atChars: CONTEXT_BUDGET.clearAtChars, keep: CONTEXT_BUDGET.keepLatest } } : {}) }, undefined, undefined, undefined, undefined, [mail] as never, undefined, false, undefined, undefined, gateway);
  await responder.respond(ownerTyped({ traceId: `tg-results-${contextCaps}`, conversationRef: 'owner', surface: 'telegram', text: 'Read every planning thread.' }), async (_hop, work) => work());
  const kept = (turns: readonly LLMToolTurn[]) => turns.filter(turn => !turn.output.includes('[cleared: ')).length;
  const firstCleared = sent.find(turns => kept(turns) < turns.length);
  return { firstCleared: firstCleared && kept(firstCleared), last: kept(sent.at(-1)!) };
});

it('with WALDO_CONTEXT_CAPS an owner turn clears its tool results down to the latest three; without it, it halves them', async () => {
  const capped = await clearingIn(true);
  const plain = await clearingIn(false);
  expect(capped.firstCleared).toBe(3);
  expect(plain.firstCleared).toBeGreaterThan(3);
});
