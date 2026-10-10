import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EgressBlock } from '../src/channels/telegram-api';

const wire = vi.hoisted(() => ({ sends: [] as string[], lose: false }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number }) => {
    wire.sends.push(method);
    if (wire.lose) throw new Error('synthetic response loss');
    return method === 'sendMessage' ? { message_id: 91, chat: { id: payload.chat_id } } : true;
  } };
});
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('event fixture forbids model calls'); } }; } }));
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

const directory = { presences: new Set<string>(), asked: 0, outage: false };
const presence = (doName: string, subject: string) => `${doName}|telegram|${subject}`;

beforeEach(() => {
  wire.sends = []; wire.lose = false; directory.presences = new Set(); directory.asked = 0; directory.outage = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith('/rest/v1/rpc/assert_channel_presence')) return new Response('unexpected', { status: 500 });
    directory.asked += 1;
    if (directory.outage) throw new Error('directory unavailable');
    const asked = JSON.parse(String(init?.body)) as { p_do_name: string; p_provider: string; p_subject: string };
    return Response.json(directory.presences.has(`${asked.p_do_name}|${asked.p_provider}|${asked.p_subject}`));
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

// The headers handleEventIngress sends: no x-waldo-do-name, no x-waldo-telegram-subject.
const ingressHeaders = (id: string): Record<string, string> => ({
  'x-waldo-origin': 'https://waldo-runtime.fixture.invalid', 'x-waldo-event-source': 'uptime', 'x-waldo-event-notify': '1',
  'x-waldo-event-delivery': `id:${id}`, 'x-waldo-event-digest': 'a'.repeat(64),
});
const body = JSON.stringify({ subject: 'fixture', kind: 'incident', title: 'fixture title' });

let sequence = 0;
const driveEvent = async (identity: Record<string, string | boolean>, arrange?: () => void) => {
  const stub = env.TRACER_DO.get(env.TRACER_DO.idFromName(`event-owner-egress-${sequence++}`));
  return runInDurableObject(stub, async (_instance, state) => {
    const owner = new TelegramOwnerDO(state, {
      ...env, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined,
      SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret',
    });
    for (const [key, value] of Object.entries(identity)) state.storage.kv.put(key, value);
    arrange?.();
    const hops: Record<string, unknown>[] = [];
    const logged = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      try { const record = JSON.parse(String(line)) as Record<string, unknown>; if (record.hop === 'telegram_send' || record.hop === 'event_ingress') hops.push(record); } catch { /* not a hop line */ }
    });
    try {
      const response = await owner.fetch(new Request('https://telegram-owner/event', { method: 'POST', body, headers: ingressHeaders(`e${sequence}`) }));
      const run = state.storage.sql.exec<{ status: string }>("SELECT status FROM background_runs WHERE kind = 'event'").toArray();
      const admission = state.storage.sql.exec<{ state: string }>('SELECT state FROM event_admissions').toArray();
      return { status: response.status, runs: run.map(row => row.status), admission: admission.map(row => row.state), hops };
    } finally { logged.mockRestore(); await state.storage.deleteAlarm(); }
  });
};

describe('an event notification to a directory-backed owner', () => {
  it('reaches a Telegram-linked owner whose presence is active', async () => {
    directory.presences.add(presence('do-linked', '7'));
    const outcome = await driveEvent({ do_name: 'do-linked', telegram_subject: '7' });
    expect(outcome).toMatchObject({ status: 200, runs: ['completed'], admission: ['completed'] });
    expect(outcome.hops.map(hop => [hop.hop, hop.ok])).toEqual([['event_ingress', true]]);
    expect(wire.sends).toEqual(['sendMessage']);
    expect(directory.asked).toBe(1);
  });

  // A send that threw may or may not have reached Telegram: that stays unknown and is never retried.
  it('keeps a lost response unknown, not blocked', async () => {
    directory.presences.add(presence('do-linked', '7'));
    wire.lose = true;
    const outcome = await driveEvent({ do_name: 'do-linked', telegram_subject: '7' });
    expect(outcome).toMatchObject({ runs: ['stopped'], admission: ['unknown'] });
    expect(outcome.hops).toEqual([expect.objectContaining({ hop: 'event_ingress', ok: false, code: 'notification_unknown' })]);
  });

  // The egress gate must keep failing closed on the event route exactly as it does for replies. The directory
  // call count tells the branches apart: the local checks block without a call, the presence recheck makes one.
  // A blocked send never left the Worker, so the event is recorded as not sent, and the blocked line names the branch.
  const refusals: ReadonlyArray<readonly [string, Record<string, string | boolean>, () => void, number, EgressBlock]> = [
    ['no Telegram subject is bound (owner resolves to 0)', { do_name: 'do-x' }, () => { directory.presences.add(presence('do-x', '7')); }, 0, 'owner_unbound'],
    ['the owner unlinked Telegram', { do_name: 'do-x', telegram_subject: '7', telegram_unlinked: true }, () => { directory.presences.add(presence('do-x', '7')); }, 0, 'unlinked'],
    ['the directory says the subject was rebound away', { do_name: 'do-x', telegram_subject: '7' }, () => undefined, 1, 'presence_inactive'],
    ['the directory is unreachable', { do_name: 'do-x', telegram_subject: '7' }, () => { directory.outage = true; }, 1, 'presence_unavailable'],
    ['the DO has no do_name to assert presence for', { telegram_subject: '7' }, () => undefined, 0, 'presence_inactive'],
  ];
  it.each(refusals)('does not send when %s', async (_why, identity, arrange, directoryCalls, reason) => {
    const outcome = await driveEvent(identity, arrange);
    expect(outcome).toMatchObject({ status: 200, runs: ['stopped'], admission: ['undelivered'] });
    expect(wire.sends).toEqual([]);
    expect(directory.asked).toBe(directoryCalls);
    expect(outcome.hops).toEqual([
      { hop: 'telegram_send', ok: false, skipped: 'blocked', method: 'sendMessage', reason },
      expect.objectContaining({ hop: 'event_ingress', ok: false, code: 'notification_blocked' }),
    ]);
  });
});
