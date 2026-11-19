import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOL_PERMISSIONS, triggerTypeSchema, type LLMRequest, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { ConversationStore } from '../src/channels/conversation-store';
import { checkBackReply, LOOP_CHECK_BACK_TOOLS, loopCheckBackText } from '../src/channels/check-back';
import { dueLoops } from '../src/channels/heartbeat';
import { loopBook, loopHandlers, openLoopsPrompt } from '../src/channels/loops';
import { passedLocal, passedSince } from '../src/channels/past-date';
import { localIso } from '../src/channels/reminders';
import { INWARD_RECEIPTS_HEADER } from '../src/conversation/inward-receipts';
import { ownerJobAdmission } from '../src/identity/surface-owner-admission';
import type { LLMGatewayAdapter } from '../src/llm/provider';

const OWNER = '10000000-0000-0000-0000-000000000001';
const DAY = 86_400_000;

describe('a passed date reads as passed', () => {
  const now = Date.parse('2026-11-19T10:00:00Z');
  it.each([
    ['2026-11-16T09:30', 'passed 3 days ago'],
    ['2026-11-19T07:00', 'passed 3 hours ago'],
    ['2026-11-19T09:45', 'passed less than an hour ago'],
    ['2026-11-19T11:00', ''],
    ['2026-11-18', 'passed yesterday'],
    ['2026-11-16', 'passed 3 days ago'],
    ['2026-11-19', ''],
    ['not a date', ''],
  ])('%s on the owner\'s clock reads "%s"', (at, words) => expect(passedLocal(at, now, 'UTC')).toBe(words));

  it('reads the owner\'s own clock, not UTC', () => {
    // 10:00 UTC is 15:30 in Kolkata, so 14:00 there has passed while 16:00 has not.
    expect(passedLocal('2026-11-19T14:00', now, 'Asia/Kolkata')).toBe('passed 1 hour ago');
    expect(passedLocal('2026-11-19T16:00', now, 'Asia/Kolkata')).toBe('');
  });

  it('an instant behind now reads the same way', () => {
    expect(passedSince(now - 2 * DAY, now)).toBe('passed 2 days ago');
    expect(passedSince(now + 1, now)).toBe('');
    expect(passedSince(Number.NaN, now)).toBe('');
  });
});

const allowed = (name: string) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly string[]).includes(name));
const fake = (name: string) => ({ name: name as ToolName, description: `The ${name} tool.`, schema: z.object({}).passthrough(), trigger_allowlist: allowed(name),
  handle: async () => ({ ok: true as const, data: { done: name }, source_taint: null }) });

// The heartbeat's check-back turn, as owner-do runs it: tainted by the reader worker's result, lean, with the check-back tools.
const checkBack = async (sql: SqlStorage, closeId: (ids: Readonly<{ passed: string; ahead: string }>) => string) => {
  const now = Date.now();
  let n = 0;
  const book = loopBook(sql, { newId: () => String(++n), now: () => now });
  const passed = book.open({ title: 'Send the Northwind deck to Priya', due: localIso(now - 3 * DAY, 'UTC').slice(0, 16) });
  const ahead = book.open({ title: 'Renew the passport', due: localIso(now + 20 * DAY, 'UTC').slice(0, 16) });
  const id = closeId({ passed: passed.id, ahead: ahead.id });
  const tools = [...loopHandlers(book), ...LOOP_CHECK_BACK_TOOLS.filter((name) => name !== 'close_loop' && name !== 'get_context').map(fake)];
  const requests: LLMRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    requests.push(request);
    const asked = requests.filter((seen) => !seen.response_format).length;
    const call = !request.response_format && asked === 1 ? { call_id: 'close', name: 'close_loop', arguments: JSON.stringify({ id, outcome: 'done' }) } : undefined;
    return { ok: true, data: { model: request.model, text: request.response_format ? '{}' : call ? '' : 'SKIP', ...(call ? { tool_calls: [call] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  const admission = await ownerJobAdmission({ lookup: async () => ({ ownerId: OWNER, bindingRef: 'runtime:owner-demo', revision: '5', physicalDoId: 'actual-do' }),
    expectedPhysicalDoId: 'actual-do', job: 'heartbeat', occurrenceKey: `heartbeat:${crypto.randomUUID()}`, occurredAt: Date.now() - 1 });
  const saved: Parameters<ConversationStore['save']>[0][number][] = [];
  const store: ConversationStore = { load: async () => ({ entries: [...saved], leafId: saved.at(-1)?.id ?? null }), save: async (rows) => { saved.push(...rows); } };
  const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture', toolLoader: 'harness' }];
  args[1] = store; args[3] = () => undefined; args[5] = tools as never; args[7] = false; args[10] = gateway;
  args[21] = { jobHost: { admit: async () => admission, chain: (_admission, surfaceChain) => surfaceChain }, leanScheduled: true,
    loopIsSourceBound: (loop) => book.sourceBound(loop), loopHasPassed: (loop) => book.passed(loop, localIso(Date.now(), 'UTC')) };
  const owner = createOwnerResponder(...args);
  const due = dueLoops(sql, now, 'UTC');
  const text = `${loopCheckBackText(due, now, 'UTC')}\n\n[What the reader found, outside content:]\nPriya replied on Monday: "Got the deck, thanks."`;
  const raw = await owner.prompt('heartbeat:1', 'telegram-7', text, async (_hop, work) => work(), 'telegram', LOOP_CHECK_BACK_TOOLS, undefined, undefined, undefined, 'external', 'decides', undefined, undefined, true);
  // Read inside the object's own context: storage cannot be touched once the callback returns.
  return { status: (loop: string) => book.get(loop)?.status, passed, ahead, now, text, reply: checkBackReply(raw), requests: requests.filter((request) => !request.response_format),
    stillDue: dueLoops(sql, now + DAY, 'UTC').map((loop) => loop.id) };
};

const withSql = <T,>(name: string, work: (sql: SqlStorage) => Promise<T>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(name)), async (_instance, state) => work(state.storage.sql));

describe('a scheduled run that read outside content closes the owner\'s loop once its time has passed', () => {
  it('the loop due 3 days ago is shown as passed, closed by the check-back, listed for the owner, and not raised again', async () => {
    const { statuses, passed, text, reply, stillDue } = await withSql('passed-loop-closes', async (sql) => {
      const run = await checkBack(sql, (ids) => ids.passed);
      return { ...run, statuses: { passed: run.status(run.passed.id) } };
    });
    expect(text).toContain('Send the Northwind deck to Priya (due');
    expect(text).toContain('passed 3 days ago');
    expect(statuses.passed).toBe('done');
    expect(reply).toContain(INWARD_RECEIPTS_HEADER);
    expect(reply).toContain('Closed "Send the Northwind deck to Priya"');
    expect(stillDue).not.toContain(passed.id);
  });

  it('a loop still ahead stays open: closing it under outside content still needs the owner\'s card', async () => {
    const { status, requests } = await withSql('ahead-loop-carded', async (sql) => {
      const run = await checkBack(sql, (ids) => ids.ahead);
      return { ...run, status: run.status(run.ahead.id) };
    });
    expect(status).toBe('open');
    expect(JSON.stringify(requests[1])).toContain('taint_needs_approval');
  });

  it('the owner\'s open loops say which have passed', async () => {
    await withSql('passed-loop-prompt', async (sql) => {
      const now = Date.parse('2026-11-19T10:00:00Z');
      const book = loopBook(sql, { newId: () => crypto.randomUUID().slice(0, 6), now: () => now });
      book.open({ title: 'Pitch rehearsal', due: '2026-11-16T09:00' });
      book.open({ title: 'Board call', due: '2026-11-21T09:00' });
      const prompt = openLoopsPrompt(book, 'UTC', 10_000, false, now);
      expect(prompt).toContain('Pitch rehearsal (due 2026-11-16 09:00, passed 3 days ago)');
      expect(prompt).toContain('Board call (due 2026-11-21 09:00)');
      expect(prompt).toContain('close it with close_loop instead of raising it again');
    });
  });
});
