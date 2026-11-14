import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { dayCardsWhy, dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { appApprovalAtRevision, appApprovalV1Schema, type AppApprovalV1 } from '../../contracts/src/app/approvals';

// "Why this changed" end to end: the Brief reads memory, proposes a change with the steps behind it, and the card and the
// day card carry only the steps the turn's own reads stand behind, at the time of those reads.
const fixture = vi.hoisted(() => ({ requests: [] as string[], round: 0, why: [] as unknown[], claim: 0 }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const sent = JSON.stringify(request.request);
    const reply = (data: object) => ({ ok: true as const, data: { model: request.request.model, text: '', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...data } });
    if (!sent.includes('[Scheduled card')) return reply({ text: 'SKIP' });
    fixture.requests.push(sent);
    fixture.round += 1;
    // read_thread fails here (no Google account): a call that failed stands behind no step, though its arguments name the thread.
    if (fixture.round === 1) return reply({ tool_calls: [{ call_id: 'c-read', name: 'read_memory', arguments: '{}' }, { call_id: 'c-thread', name: 'read_thread', arguments: '{"thread_id":"thr-priya"}' }] });
    if (fixture.round === 2) return reply({ tool_calls: [{ call_id: 'c-propose', name: 'propose_action', arguments: JSON.stringify({
      tool: 'set_reminder', args: { note: 'Leave for the half-marathon training run', at: '2026-10-24T17:30' }, reasoning: 'Your goal is the half in December.',
      why: fixture.why,
    }) }] });
    return reply({ text: 'The Brief: one run to protect today.' });
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '5d6e7f80-91a2-4b3c-8d4e-5f6a7b8c9d0e';
const AT = Date.parse('2026-10-24T08:00:00Z');
const DAY = '2026-10-24';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };

beforeEach(() => {
  fixture.requests = []; fixture.round = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json({ context: null, previous: null });
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown>; desk: { approvals(now: number): Promise<readonly AppApprovalV1[]> } }; alarm(): Promise<void>; serial(work: () => Promise<void>): Promise<void> }>;
type Brief = Readonly<{ approvals: readonly AppApprovalV1[]; rows: readonly Record<string, SqlStorageValue>[]; dayWhy: ReturnType<typeof dayCardsWhy>; readAt: number; offered: string }>;

const brief = async (name: string, trail: '1' | '0', why: (claim: number) => unknown[]): Promise<Brief> => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  return runInDurableObject(stub, async (_instance, state) => {
    const originalNow = Date.now;
    Date.now = () => AT;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      claimStore(state.storage.sql).add({ kind: 'goal', text: 'Run the half marathon in December', source: 'stated', evidence: '"I want to run the half"', origin: 'owner', source_ref: 'owner, app-1' }, '2026-10-20T08:00:00Z');
      const claim = state.storage.sql.exec<{ id: number }>('SELECT id FROM claims ORDER BY id DESC LIMIT 1').one().id;
      fixture.why = why(claim);
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, WHY_TRAIL: trail }) as unknown as Owner;
      await owner.setup('app').ready;
      await owner.serial(async () => undefined);
      state.storage.sql.exec('DELETE FROM schedule');
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await new Scheduler(state.storage.sql, state.storage, productionDeps())
        .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
      state.storage.kv.put('owner_alarm_last_v1', 1);
      await owner.alarm();
      expect(fixture.round).toBe(3);
      const rows = state.storage.sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM ledger WHERE kind = 'tainted_action'").toArray();
      const approvals = await owner.setup('app').desk.approvals(Date.now());
      const offered = fixture.requests[0]!;
      const readAt = state.storage.sql.exec<{ at: number }>("SELECT json_extract(why_json, '$[0].at') AS at FROM ledger WHERE why_json IS NOT NULL").toArray()[0]?.at ?? 0;
      return { approvals, rows, dayWhy: dayCardsWhy(dayPlanBook(state.storage.sql), DAY), readAt, offered };
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};

const CLAIMED = (claim: number) => [
  { verb: 'read', label: 'Read your goal for the half', source: { kind: 'memory_node', ref: String(claim) } },
  // Nothing in this turn read a calendar: the model's claim alone is not a step.
  { verb: 'checked', label: 'Found the 3pm clash', source: { kind: 'calendar_event', ref: 'evt-3pm' } },
  { verb: 'read', label: "Read Priya's reply", source: { kind: 'mail_thread', ref: 'thr-priya' } },
  { verb: 'prepared', label: 'Found an evening slot for the run', source: { kind: 'memory_node', ref: String(claim) } },
];

describe('the Brief proposes with the steps behind it', () => {
  it('keeps the steps its reads stand behind, on the card and on the Brief, and drops the one nothing read', async () => {
    const { approvals, rows, dayWhy, readAt, offered } = await brief('why-brief', '1', CLAIMED);
    expect(offered).toContain('"why"');
    expect(rows).toHaveLength(1);
    const [card] = approvals;
    expect(card?.kind).toBe('tainted_action');
    expect(card?.why).toEqual([
      { at: readAt, verb: 'read', label: 'Read your goal for the half', source: 'memory_node' },
      { at: readAt, verb: 'prepared', label: 'Found an evening slot for the run', source: 'memory_node' },
    ]);
    expect(readAt).toBe(AT);
    expect(appApprovalV1Schema.safeParse(card).success).toBe(true);
    expect(appApprovalAtRevision(card!, 7).why).toBeUndefined();
    expect(dayWhy.get('card:brief')).toEqual(card?.why);
    // The trail is beside the card, never in what the owner approves.
    expect(String(rows[0]!.payload_json)).not.toContain('Read your goal');
    expect(String(rows[0]!.payload_json)).not.toContain('"why"');
    expect(String(rows[0]!.summary)).not.toContain('Read your goal');
  });

  it('a card whose every step stands on nothing carries no trail, and neither does the Brief', async () => {
    const { approvals, dayWhy } = await brief('why-brief-none', '1', () => [
      { verb: 'checked', label: 'Found the 3pm clash', source: { kind: 'calendar_event', ref: 'evt-3pm' } },
    ]);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.why).toBeUndefined();
    expect(dayWhy.size).toBe(0);
  });

  it('a step whose line carries a health reading is dropped, and never stored', async () => {
    const { approvals, rows } = await brief('why-brief-health', '1', claim => [
      { verb: 'read', label: 'Read your goal for the half', source: { kind: 'memory_node', ref: String(claim) } },
      { verb: 'read', label: 'HRV 38 ms, so an easy run', source: { kind: 'memory_node', ref: String(claim) } },
      { verb: 'read', label: 'Recovery at 42, so the run moves', source: { kind: 'memory_node', ref: String(claim) } },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/38 ms|at 42/);
    expect(approvals[0]!.why?.map(step => step.label)).toEqual(['Read your goal for the half']);
  });

  it('with the switch off the tool takes no steps: its definition is as before and a call carrying them proposes nothing', async () => {
    const { approvals, rows, dayWhy, offered } = await brief('why-brief-off', '0', CLAIMED);
    expect(offered).not.toContain('"why"');
    expect(rows).toHaveLength(0);
    expect(approvals).toHaveLength(0);
    expect(dayWhy.size).toBe(0);
  });
});
