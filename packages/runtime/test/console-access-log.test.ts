import { describe, expect, expectTypeOf, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { consoleAccess } from '../src/channels/console';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { DASHBOARD_ACCESS_LOG_PATH, readAccessLogQuery } from '../src/channels/dashboard-access-log';
import { STEP_UP_ROUTES } from '../src/channels/console-step-up';
import type { ApprovalDesk, RecordedLedgerKind } from '../src/channels/approvals';
import { approvalKindV1Schema, type ApprovalKindV1 } from '../../contracts/src/app/parts';
import { TRACE_KEPT } from '../src/channels/harness';

// Patrol's access log: which tools Waldo used and which actions the owner decided, from Waldo's own records, for any signed-in
// console session. It never carries a step note, a mail subject, a message body, a health value, a token or the csrf.
const root = 'https://telegram-owner';
const HOUR = 60 * 60_000, DAY = 24 * HOUR;
const MAIL_SUBJECT = 'Re: kidney biopsy results from Dr Okafor';
const HEALTH_NOTE = 'resting HRV 173.5 ms, glucose 9.81';

type Log = {
  version: 1; as_of: string; window_days: number; kept_steps: number;
  tools: { rows: { at: string; tool: string; category: string; kind: string; ok: boolean }[]; next_before: number | null; oldest_at: string | null };
  approvals: { rows: { at: string; kind: string; decision: string; decided_at: string | null }[]; next_before: string | null };
};

const owner = async (name: string) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const token = await runInDurableObject(stub, (instance, state) => {
    Object.assign((instance as unknown as { env: Record<string, unknown> }).env, { TELEGRAM_BOT_TOKEN: '123:synthetic', OPENAI_API_KEY: 'synthetic-key' });
    state.storage.kv.put('do_name', name);
    return consoleAccess(state.storage).grant();
  });
  const headers = (extra: Record<string, string> = {}) => ({ cookie: `waldo_console=${token}`, accept: 'application/json', ...extra });
  // Builds the runtime, so the tables the fixtures write exist.
  expect((await stub.fetch(`${root}${CONTROLS_PATH}?view=connections`, { headers: headers() })).status).toBe(200);
  const log = (query = '', init: RequestInit = {}) => stub.fetch(`${root}${DASHBOARD_ACCESS_LOG_PATH}${query}`, { headers: headers(), ...init });
  const seedTrace = (rows: readonly Readonly<{ at: number; hop: string; ok?: boolean; note?: string }>[]) => runInDurableObject(stub, (_instance, state) => {
    for (const row of rows) state.storage.sql.exec("INSERT INTO trace_log (at, trace, hop, ok, ms, note) VALUES (?, 'trace-log-fixture', ?, ?, 5, ?)", row.at, row.hop, row.ok === false ? 0 : 1, row.note ?? '');
  });
  const seedApproval = (id: string, kind: string, status: string, at: number, summary: string, payload: unknown) => runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL,
      undo_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)`);
    state.storage.sql.exec('INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)', id, kind, status, summary, JSON.stringify(payload), at, status === 'open' ? null : at + 60_000);
  });
  const act = async (action: string) => {
    const response = await stub.fetch(`${root}${CONTROLS_PATH}?view=connections`, { headers: headers() });
    const read = await response.json() as { csrf: string; revision: string };
    return stub.fetch(root + CONTROL_ACTION_PATH, { method: 'POST', headers: headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({ csrf: read.csrf, revision: read.revision, view: 'connections', action, id: '', request_id: `log-${crypto.randomUUID()}`.slice(0, 80) }) });
  };
  return { stub, token, headers, log, seedTrace, seedApproval, act };
};

describe('the access log is a signed-in read', () => {
  it('needs no email code: the Vault no longer gates anything, and no other route was added', () => {
    expect(Object.keys(STEP_UP_ROUTES).some(path => path.startsWith('/console/dashboard/api/'))).toBe(false);
  });

  it('answers a session that never proved an email code, and refuses a signed-out read', async () => {
    const o = await owner('log-open-owner');
    const now = Date.now();
    await o.seedTrace([{ at: now - 2 * HOUR, hop: 'tool_get_health' }, { at: now - HOUR, hop: 'tool_send_email', ok: false }, { at: now - HOUR, hop: 'owner_request' }]);
    await o.seedApproval('pappr1', 'email_send', 'done', now - 3 * HOUR, 'Send to Ana', { to: ['ana@example.test'] });
    const response = await o.log();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const log = await response.json() as Log;
    expect(log).toMatchObject({ version: 1, window_days: 30, kept_steps: TRACE_KEPT });
    expect(log.tools.rows.map(row => [row.tool, row.category, row.kind, row.ok])).toEqual([['send_email', 'mail', 'acted', false], ['get_health', 'core', 'read', true]]);
    expect(log.approvals.rows).toEqual([{ at: new Date(now - 3 * HOUR).toISOString(), kind: 'email_send', decision: 'done', decided_at: new Date(now - 3 * HOUR + 60_000).toISOString() }]);
    const body = JSON.stringify(log);
    for (const leak of ['csrf', o.token, 'ana@example.test', 'Send to Ana']) expect(body).not.toContain(leak);
    const signedOut = await o.stub.fetch(`${root}${DASHBOARD_ACCESS_LOG_PATH}`, { headers: { accept: 'application/json' } });
    expect(signedOut.status).toBe(401);
  });

  it('shows each owner only their own records', async () => {
    const a = await owner('log-owner-a'), b = await owner('log-owner-b');
    const now = Date.now();
    await b.seedTrace([{ at: now - HOUR, hop: 'tool_web_search' }]);
    await b.seedApproval('powner-b', 'calendar_change', 'done', now - HOUR, 'B only', {});
    expect((await b.stub.fetch(`${root}${DASHBOARD_ACCESS_LOG_PATH}`, { headers: a.headers() })).status).toBe(401);
    const own = await (await a.log()).json() as Log;
    expect(own.tools.rows.some(row => row.tool === 'web_search')).toBe(false);
    expect(own.approvals.rows).toEqual([]);
    expect((await (await b.log()).json() as Log).approvals.rows).toHaveLength(1);
  });

  it('shows tool names and categories only: no step notes, no hallucinated tool names, no approval text', async () => {
    const o = await owner('log-hostile-owner');
    const now = Date.now();
    await o.seedTrace([
      { at: now - HOUR, hop: 'tool_get_health', note: HEALTH_NOTE },
      { at: now - HOUR, hop: `tool_${MAIL_SUBJECT}` },
      { at: now - HOUR, hop: 'tool_search_communication', note: MAIL_SUBJECT },
    ]);
    await o.seedApproval('appr-hostile', 'email_send', 'open', now - HOUR, MAIL_SUBJECT, { subject: MAIL_SUBJECT, body: HEALTH_NOTE, hrv: 173.5 });
    await o.seedApproval('appr-unknown', 'email_send', `status ${HEALTH_NOTE}`, now - HOUR, 'x', {});
    await o.seedApproval('appr-kind', `kind ${MAIL_SUBJECT}`, 'done', now - HOUR, 'x', {});
    const response = await o.log();
    const body = await response.text();
    for (const leak of ['biopsy', 'Okafor', 'HRV', '173.5', '9.81', 'glucose']) expect(body).not.toContain(leak);
    const log = JSON.parse(body) as Log;
    expect(log.tools.rows.map(row => row.tool).sort()).toEqual(['get_health', 'other', 'search_communication']);
    expect(log.approvals.rows.map(row => [row.kind, row.decision]).sort()).toEqual([['email_send', 'open'], ['email_send', 'other']]);
  });

  it('pages the access log and keeps it to the last 30 days', async () => {
    const o = await owner('log-page-owner');
    const now = Date.now();
    await o.seedTrace([{ at: now - 40 * DAY, hop: 'tool_web_search' }, ...Array.from({ length: 60 }, (_, n) => ({ at: now - (n + 1) * 60_000, hop: 'tool_get_context' }))]);
    const first = await (await o.log()).json() as Log;
    expect(first.tools.rows).toHaveLength(50);
    expect(first.tools.next_before).toEqual(expect.any(Number));
    const second = await (await o.log(`?tools_before=${first.tools.next_before}`)).json() as Log;
    expect(second.tools.rows).toHaveLength(10);
    expect(second.tools.next_before).toBeNull();
    expect([...first.tools.rows, ...second.tools.rows].some(row => row.tool === 'web_search')).toBe(false);
  });

  it('lists only approvals: a draft Waldo recorded as done without asking is not shown as approved', async () => {
    const o = await owner('log-record-owner');
    const now = Date.now();
    await o.seedApproval('pdraftlike', 'calendar_change', 'done', now - 2 * HOUR, 'Moved standup', {});
    // desk.record writes a done row with no approval, as draft_email does.
    await runInDurableObject(o.stub, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES ('lrecorded', 'email_draft', 'done', 'Drafted', '{}', NULL, ?, ?)", now - HOUR, now - HOUR);
    });
    const log = await (await o.log()).json() as Log;
    expect(log.approvals.rows.map(row => [row.kind, row.decision])).toEqual([['calendar_change', 'done']]);
  });

  it('a kind Waldo records without asking can never be one the owner decides', () => {
    expectTypeOf<Extract<RecordedLedgerKind, ApprovalKindV1>>().toBeNever();
    const record: ApprovalDesk['record'] = () => undefined;
    // @ts-expect-error an approval kind is not a recorded kind
    record('email_send', 'Sent', {});
    // @ts-expect-error an approval kind is not a recorded kind
    record('calendar_change', 'Moved', {});
    // @ts-expect-error a kind must be named, not any string
    record(String('email_draft'), 'Drafted', {});
    record('email_draft', 'Drafted', {});
    expect(approvalKindV1Schema.options).not.toContain('email_draft');
  });

  it('pages approvals by time and id, with the page break inside one timestamp, and keeps them to the last 30 days', async () => {
    const o = await owner('log-approval-page-owner');
    const now = Date.now(), tie = now - HOUR;
    await o.seedApproval('pold', 'email_send', 'done', now - 40 * DAY, 'old', {});
    // Every row shares one created_at, so the cursor falls inside the tie; each row's decided_at names it.
    await runInDurableObject(o.stub, (_instance, state) => {
      for (let n = 0; n < 60; n++) state.storage.sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, 'message_send', 'skipped', 's', '{}', NULL, ?, ?)",
        `p${String(n).padStart(3, '0')}`, tie, tie + n + 1);
    });
    const first = await (await o.log()).json() as Log;
    expect(first.approvals.rows).toHaveLength(50);
    expect(first.approvals.next_before).toBe(`${tie}.p010`);
    const second = await (await o.log(`?approvals_before=${encodeURIComponent(first.approvals.next_before!)}`)).json() as Log;
    expect(second.approvals.rows).toHaveLength(10);
    expect(second.approvals.next_before).toBeNull();
    const named = (rows: Log['approvals']['rows']) => rows.map(row => Date.parse(row.decided_at!) - tie);
    const [one, two] = [named(first.approvals.rows), named(second.approvals.rows)];
    expect(one.filter(n => two.includes(n))).toEqual([]);
    expect([...one, ...two]).toEqual(Array.from({ length: 60 }, (_, n) => 60 - n));
    expect([...first.approvals.rows, ...second.approvals.rows].every(row => Date.parse(row.at) === tie)).toBe(true);
  });

  it('refuses a query it does not name, another method and a spent read budget, with generic errors', async () => {
    const o = await owner('log-invalid-owner');
    for (const query of ['?owner=other', '?tools_before=abc', '?tools_before=0', '?tools_before=1&tools_before=2', `?approvals_before=${'9'.repeat(30)}`, '?approvals_before=12', '?approvals_before=12.', '?approvals_before=.p1', `?approvals_before=12.${'a'.repeat(129)}`, '?approvals_before=12.p%20x', '?approvals_before=01.p1']) {
      const response = await o.log(query);
      expect([query, response.status, await response.json()]).toEqual([query, 400, { error: 'invalid_query' }]);
    }
    const posted = await o.log('', { method: 'POST', headers: o.headers({ 'content-type': 'application/x-www-form-urlencoded' }), body: 'action=vault.reveal' });
    expect(posted.status).toBe(405);
    await runInDurableObject(o.stub, (_instance, state) => { state.storage.kv.put('console:controls-rate:read', { start: Date.now(), count: 90 }); });
    const limited = await o.log();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
  });

  it('an action the console does not name is refused with a generic error', async () => {
    const o = await owner('log-unknown-action-owner');
    const refused = await o.act('vault.reveal');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'invalid_action' });
  });

  it('reads only the paging keys it names', () => {
    expect(readAccessLogQuery(new URLSearchParams())).toEqual({});
    expect(readAccessLogQuery(new URLSearchParams('tools_before=12&approvals_before=1793008800000.p00a'))).toEqual({ toolsBefore: 12, approvalsBefore: { at: 1793008800000, id: 'p00a' } });
    for (const bad of ['view=x', 'tools_before=-1', 'tools_before=1.5', 'approvals_before=', 'tools_before=1&tools_before=1']) expect(readAccessLogQuery(new URLSearchParams(bad)), bad).toBeNull();
  });
});
