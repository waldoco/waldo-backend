import { describe, expect, expectTypeOf, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { consoleAccess } from '../src/channels/console';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { MEMORY_CONTROL_PATH } from '../src/channels/dashboard-memory-actions';
import { DASHBOARD_VAULT_PATH, projectVault, readVaultQuery } from '../src/channels/dashboard-vault';
import { STEP_UP_ROUTES } from '../src/channels/console-step-up';
import type { ApprovalDesk, RecordedLedgerKind } from '../src/channels/approvals';
import { approvalKindV1Schema, type ApprovalKindV1 } from '../../contracts/src/app/parts';
import { HEALTH_READ_LIMIT, healthSharing } from '../src/channels/dashboard-health';
import { TRACE_KEPT } from '../src/channels/harness';

const memoryKv = () => { const map = new Map<string, unknown>(); return { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); } }; };

// The Vault shows what Waldo keeps, what it can reach and what it did, behind a fresh email code. Without one, the read
// answers step_up_required before any of it is read. It never carries a token, a secret reference, a mail subject, a
// message body or a health value, and every change it offers runs through the console's existing action path.
const root = 'https://telegram-owner';
const HOUR = 60 * 60_000, DAY = 24 * HOUR;
const MEMORY_TEXT = 'Keeps a vault-marker-ledger of bird sightings';
const MAIL_SUBJECT = 'Re: kidney biopsy results from Dr Okafor';
const HEALTH_NOTE = 'resting HRV 173.5 ms, glucose 9.81';
const LOCAL_TOKEN = '1//synthetic-refresh-VAULTLEAK';
const SECRET_PATH = 'sk-path-VAULTLEAK';

type Vault = {
  version: 1; state: 'available'; as_of: string;
  memory: { state: string; groups: { kind: string; total: number; items: { id: string; text: string; source_label: string; recorded_at: string | null }[] }[] };
  connections: {
    token_note: string;
    google: { account_id: string; email: string; grants: string[]; token_storage: string; connected_at: null; last_used_at: null; revoke: { view: string; action: string } }[];
    mcp: { id: string; name: string; host: string; scopes: string[]; connected_at: string | null; revoke: { view: string; action: string } }[];
    channels: { channel: string; state: string; revoke: { view: string; action: string } | null }[];
    health: { state: string };
  };
  access_log: { window_days: number; kept_steps: number; tools: { rows: { at: string; tool: string; category: string; kind: string; ok: boolean }[]; next_before: number | null; oldest_at: string | null }; approvals: { rows: { at: string; kind: string; decision: string; decided_at: string | null }[]; next_before: string | null } };
};

const owner = async (name: string) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const token = await runInDurableObject(stub, (instance, state) => {
    Object.assign((instance as unknown as { env: Record<string, unknown> }).env, { TELEGRAM_BOT_TOKEN: '123:synthetic', OPENAI_API_KEY: 'synthetic-key' });
    state.storage.kv.put('do_name', name);
    return consoleAccess(state.storage).grant();
  });
  const headers = (extra: Record<string, string> = {}) => ({ cookie: `waldo_console=${token}`, accept: 'application/json', ...extra });
  // Builds the runtime and the MCP store, so the tables the fixtures write exist.
  expect((await stub.fetch(`${root}${CONTROLS_PATH}?view=connections`, { headers: headers() })).status).toBe(200);
  const codeAge = (age: number | null) => runInDurableObject(stub, async (_instance, state) => {
    const sessions = (await state.storage.get<Record<string, Record<string, unknown>>>('console:sessions'))!;
    const { verified_at: _old, ...rest } = sessions[token]!;
    sessions[token] = age === null ? rest : { ...rest, verified_at: Date.now() - age };
    await state.storage.put('console:sessions', sessions);
  });
  const vault = (query = '', init: RequestInit = {}) => stub.fetch(`${root}${DASHBOARD_VAULT_PATH}${query}`, { headers: headers(), ...init });
  const seedClaim = (text: string) => runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("INSERT INTO claims (kind, text, source, evidence, origin, status, created_at, last_seen_at, verification_status) VALUES ('fact', ?, 'stated', 'synthetic note', 'owner', 'active', '2026-10-01', '2026-10-01', 'owner-grounded')", text);
    return `${state.id}:claim:${state.storage.sql.exec<{ id: number }>('SELECT id FROM claims ORDER BY id DESC LIMIT 1').one().id}`;
  });
  const seedMcp = (id: string, server: string) => runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("INSERT INTO mcp_connections (id, name, server_url, auth, registration, issuer, scopes, status, connected_at) VALUES (?, ?, ?, 'none', 'none', NULL, 'notes.read', 'active', ?)", id, server, `https://mcp.example.test/${SECRET_PATH}/mcp`, Date.parse('2026-10-20T09:00:00Z'));
  });
  const seedGoogle = (accounts: readonly Record<string, unknown>[]) => runInDurableObject(stub, async (_instance, state) => { await state.storage.put('google:accounts', accounts); });
  const seedTrace = (rows: readonly Readonly<{ at: number; hop: string; ok?: boolean; note?: string }>[]) => runInDurableObject(stub, (_instance, state) => {
    for (const row of rows) state.storage.sql.exec("INSERT INTO trace_log (at, trace, hop, ok, ms, note) VALUES (?, 'trace-vault-fixture', ?, ?, 5, ?)", row.at, row.hop, row.ok === false ? 0 : 1, row.note ?? '');
  });
  const seedApproval = (id: string, kind: string, status: string, at: number, summary: string, payload: unknown) => runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL,
      undo_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)`);
    state.storage.sql.exec('INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)', id, kind, status, summary, JSON.stringify(payload), at, status === 'open' ? null : at + 60_000);
  });
  const controls = async (view: string) => {
    const response = await stub.fetch(`${root}${CONTROLS_PATH}?view=${view}`, { headers: headers() });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ csrf: string; revision: string }>;
  };
  const act = async (view: string, action: string, id: string, request = `vault-${crypto.randomUUID()}`) => {
    const read = view === 'memory'
      ? await (await stub.fetch(`${root}${MEMORY_CONTROL_PATH}?${new URLSearchParams({ id })}`, { headers: headers() })).json() as { csrf: string; revision: string }
      : await controls(view);
    return stub.fetch(root + CONTROL_ACTION_PATH, { method: 'POST', headers: headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({ csrf: read.csrf, revision: read.revision, view, action, id, request_id: request.slice(0, 80) }) });
  };
  return { stub, token, headers, codeAge, vault, seedClaim, seedMcp, seedGoogle, seedTrace, seedApproval, act };
};

describe('the Vault is locked without a fresh email code', () => {
  it('is a gated console route, so the step-up check runs before any handler', () => {
    expect(STEP_UP_ROUTES[DASHBOARD_VAULT_PATH]).toMatchObject({ gated: true, startsFlow: false });
  });

  it('answers step_up_required and sends nothing it holds, with no code or an old one', async () => {
    const o = await owner('vault-locked-owner');
    await o.seedClaim(MEMORY_TEXT);
    await o.seedMcp('mcp-locked', 'Locked Notes Server');
    await o.seedGoogle([{ id: 'conn-locked', email: 'locked-owner@example.test', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    await o.seedTrace([{ at: Date.now() - HOUR, hop: 'tool_get_health' }]);
    for (const age of [null, 3 * HOUR]) {
      await o.codeAge(age);
      const response = await o.vault();
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ error: 'step_up_required' });
      for (const held of [MEMORY_TEXT, 'Locked Notes Server', 'locked-owner@example.test', 'get_health']) expect(body).not.toContain(held);
    }
  });

  it('refuses a signed-out read', async () => {
    const o = await owner('vault-signed-out-owner');
    const response = await o.stub.fetch(`${root}${DASHBOARD_VAULT_PATH}`, { headers: { accept: 'application/json' } });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('vault');
  });
});

describe('the Vault with a fresh email code', () => {
  it('shows memories, logins and the access log from the owner\'s own records', async () => {
    const o = await owner('vault-open-owner');
    await o.codeAge(60_000);
    const claim = await o.seedClaim(MEMORY_TEXT);
    await o.seedMcp('mcp-notes', 'Team Notes');
    await o.seedGoogle([
      { id: 'conn-vaulted', email: 'vaulted@example.test', scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'] },
      { id: 'local:held@example.test', email: 'held@example.test', scopes: ['https://www.googleapis.com/auth/tasks'], refresh_token: LOCAL_TOKEN },
    ]);
    const now = Date.now();
    await o.seedTrace([{ at: now - 2 * HOUR, hop: 'tool_get_health' }, { at: now - HOUR, hop: 'tool_send_email', ok: false }, { at: now - HOUR, hop: 'owner_request' }]);
    await o.seedApproval('appr-1', 'email_send', 'done', now - 3 * HOUR, 'Send to Ana', { to: ['ana@example.test'] });
    const response = await o.vault();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const vault = await response.json() as Vault;
    expect(vault).toMatchObject({ version: 1, state: 'available' });
    const facts = vault.memory.groups.find(group => group.kind === 'fact')!;
    expect(facts.items).toContainEqual(expect.objectContaining({ id: claim, text: MEMORY_TEXT, source_label: 'You said this', recorded_at: '2026-10-01' }));
    expect(vault.connections.token_note).toBe('Tokens are stored encrypted (Supabase Vault). Waldo\'s model never sees them.');
    expect(vault.connections.google).toEqual([
      { account_id: 'conn-vaulted', email: 'vaulted@example.test', grants: ['calendar', 'gmail'], status: 'active', token_storage: 'supabase_vault', connected_at: null, last_used_at: null, revoke: { view: 'connections', action: 'google.disconnect' } },
      { account_id: 'local:held@example.test', email: 'held@example.test', grants: ['tasks'], status: 'active', token_storage: 'waldo_server', connected_at: null, last_used_at: null, revoke: { view: 'connections', action: 'google.disconnect' } },
    ]);
    expect(vault.connections.mcp).toEqual([expect.objectContaining({ id: 'mcp-notes', name: 'Team Notes', host: 'mcp.example.test', scopes: ['notes.read'], connected_at: '2026-10-20T09:00:00.000Z', revoke: { view: 'connections', action: 'mcp.disconnect' } })]);
    expect(vault.connections.channels.find(row => row.channel === 'telegram')).toBeDefined();
    // No health plane is configured in this fixture, so the section says so instead of guessing.
    expect(vault.connections.health).toEqual({ state: 'unavailable' });
    expect(vault.access_log).toMatchObject({ window_days: 30, kept_steps: TRACE_KEPT });
    expect(vault.access_log.tools.rows.map(row => [row.tool, row.category, row.kind, row.ok])).toEqual([['send_email', 'mail', 'acted', false], ['get_health', 'core', 'read', true]]);
    expect(vault.access_log.approvals.rows).toEqual([{ at: new Date(now - 3 * HOUR).toISOString(), kind: 'email_send', decision: 'done', decided_at: new Date(now - 3 * HOUR + 60_000).toISOString() }]);
  });

  it('never carries a token, a secret reference, a server path or the console\'s csrf', async () => {
    const o = await owner('vault-secret-owner');
    await o.codeAge(60_000);
    await o.seedMcp('mcp-secret', 'Secret Path Server');
    await o.seedGoogle([
      { id: 'conn-secret', email: 'secret@example.test', scopes: [], secret_id: 'vault-secret-uuid-VAULTLEAK', refresh_token: LOCAL_TOKEN },
    ]);
    const body = await (await o.vault()).text();
    for (const leak of ['VAULTLEAK', LOCAL_TOKEN, 'refresh_token', 'secret_id', 'server_url', 'csrf', o.token]) expect(body).not.toContain(leak);
  });

  it('shows tool names and categories only: no step notes, no hallucinated tool names, no approval text', async () => {
    const o = await owner('vault-hostile-owner');
    await o.codeAge(60_000);
    const now = Date.now();
    await o.seedTrace([
      { at: now - HOUR, hop: 'tool_get_health', note: HEALTH_NOTE },
      { at: now - HOUR, hop: `tool_${MAIL_SUBJECT}` },
      { at: now - HOUR, hop: 'tool_search_communication', note: MAIL_SUBJECT },
    ]);
    await o.seedApproval('appr-hostile', 'email_send', 'open', now - HOUR, MAIL_SUBJECT, { subject: MAIL_SUBJECT, body: HEALTH_NOTE, hrv: 173.5 });
    await o.seedApproval('appr-unknown', 'email_send', `status ${HEALTH_NOTE}`, now - HOUR, 'x', {});
    await o.seedApproval('appr-kind', `kind ${MAIL_SUBJECT}`, 'done', now - HOUR, 'x', {});
    const response = await o.vault();
    const body = await response.text();
    for (const leak of ['biopsy', 'Okafor', 'HRV', '173.5', '9.81', 'glucose']) expect(body).not.toContain(leak);
    const vault = JSON.parse(body) as Vault;
    expect(vault.access_log.tools.rows.map(row => row.tool).sort()).toEqual(['get_health', 'other', 'search_communication']);
    expect(vault.access_log.approvals.rows.map(row => [row.kind, row.decision]).sort()).toEqual([['email_send', 'open'], ['email_send', 'other']]);
  });

  it('pages the access log and keeps it to the last 30 days', async () => {
    const o = await owner('vault-page-owner');
    await o.codeAge(60_000);
    const now = Date.now();
    await o.seedTrace([{ at: now - 40 * DAY, hop: 'tool_web_search' }, ...Array.from({ length: 60 }, (_, n) => ({ at: now - (n + 1) * 60_000, hop: 'tool_get_context' }))]);
    const first = await (await o.vault()).json() as Vault;
    expect(first.access_log.tools.rows).toHaveLength(50);
    expect(first.access_log.tools.next_before).toEqual(expect.any(Number));
    const second = await (await o.vault(`?tools_before=${first.access_log.tools.next_before}`)).json() as Vault;
    expect(second.access_log.tools.rows).toHaveLength(10);
    expect(second.access_log.tools.next_before).toBeNull();
    expect([...first.access_log.tools.rows, ...second.access_log.tools.rows].some(row => row.tool === 'web_search')).toBe(false);
  });

  it('lists only approvals: a draft Waldo recorded as done without asking is not shown as approved', async () => {
    const o = await owner('vault-record-owner');
    await o.codeAge(60_000);
    const now = Date.now();
    await o.seedApproval('pdraftlike', 'calendar_change', 'done', now - 2 * HOUR, 'Moved standup', {});
    // desk.record writes a done row with no approval, as draft_email does.
    await runInDurableObject(o.stub, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES ('lrecorded', 'email_draft', 'done', 'Drafted', '{}', NULL, ?, ?)", now - HOUR, now - HOUR);
    });
    const vault = await (await o.vault()).json() as Vault;
    expect(vault.access_log.approvals.rows.map(row => [row.kind, row.decision])).toEqual([['calendar_change', 'done']]);
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
    const o = await owner('vault-approval-page-owner');
    await o.codeAge(60_000);
    const now = Date.now(), tie = now - HOUR;
    await o.seedApproval('pold', 'email_send', 'done', now - 40 * DAY, 'old', {});
    // Every row shares one created_at, so the cursor falls inside the tie; each row's decided_at names it.
    await runInDurableObject(o.stub, (_instance, state) => {
      for (let n = 0; n < 60; n++) state.storage.sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, 'message_send', 'skipped', 's', '{}', NULL, ?, ?)",
        `p${String(n).padStart(3, '0')}`, tie, tie + n + 1);
    });
    const first = await (await o.vault()).json() as Vault;
    expect(first.access_log.approvals.rows).toHaveLength(50);
    expect(first.access_log.approvals.next_before).toBe(`${tie}.p010`);
    const second = await (await o.vault(`?approvals_before=${encodeURIComponent(first.access_log.approvals.next_before!)}`)).json() as Vault;
    expect(second.access_log.approvals.rows).toHaveLength(10);
    expect(second.access_log.approvals.next_before).toBeNull();
    const named = (rows: Vault['access_log']['approvals']['rows']) => rows.map(row => Date.parse(row.decided_at!) - tie);
    const [one, two] = [named(first.access_log.approvals.rows), named(second.access_log.approvals.rows)];
    expect(one.filter(n => two.includes(n))).toEqual([]);
    expect([...one, ...two]).toEqual(Array.from({ length: 60 }, (_, n) => 60 - n));
    expect([...first.access_log.approvals.rows, ...second.access_log.approvals.rows].every(row => Date.parse(row.at) === tie)).toBe(true);
  });

  it('lists each memory group newest first', async () => {
    const o = await owner('vault-memory-order-owner');
    await o.codeAge(60_000);
    const older = await o.seedClaim('Older vault fact');
    const newer = await o.seedClaim('Newer vault fact');
    const vault = await (await o.vault()).json() as Vault;
    expect(vault.memory.groups.find(group => group.kind === 'fact')!.items.map(item => item.id)).toEqual([newer, older]);
  });

  it('refuses a query it does not name, another method and a spent read budget, with generic errors', async () => {
    const o = await owner('vault-invalid-owner');
    await o.codeAge(60_000);
    for (const query of ['?owner=other', '?tools_before=abc', '?tools_before=0', '?tools_before=1&tools_before=2', `?approvals_before=${'9'.repeat(30)}`, '?approvals_before=12', '?approvals_before=12.', '?approvals_before=.p1', `?approvals_before=12.${'a'.repeat(129)}`, '?approvals_before=12.p%20x', '?approvals_before=01.p1']) {
      const response = await o.vault(query);
      expect([query, response.status, await response.json()]).toEqual([query, 400, { error: 'invalid_query' }]);
    }
    const posted = await o.vault('', { method: 'POST', headers: o.headers({ 'content-type': 'application/x-www-form-urlencoded' }), body: 'action=vault.reveal' });
    expect(posted.status).toBe(405);
    await runInDurableObject(o.stub, (_instance, state) => { state.storage.kv.put('console:controls-rate:read', { start: Date.now(), count: 90 }); });
    const limited = await o.vault();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
  });

  it('an action the console does not name is refused with a generic error', async () => {
    const o = await owner('vault-unknown-action-owner');
    await o.codeAge(60_000);
    const refused = await o.act('connections', 'vault.reveal', '');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'invalid_action' });
  });
});

describe('Vault changes go through the existing console actions', () => {
  it('forgets a Vault memory through memory-controls, with the existing receipt', async () => {
    const o = await owner('vault-forget-owner');
    await o.codeAge(60_000);
    const id = await o.seedClaim(MEMORY_TEXT);
    const listed = (await (await o.vault()).json() as Vault).memory.groups.flatMap(group => group.items).map(item => item.id);
    expect(listed).toContain(id);
    const forgot = await o.act('memory', 'spot.forget', id);
    expect(forgot.status).toBe(200);
    expect(await forgot.json()).toMatchObject({ duplicate: false, receipt: { state: expect.stringMatching(/^(recorded|incomplete)$/) } });
    const after = await (await o.vault()).text();
    expect(after).not.toContain(MEMORY_TEXT);
  });

  it('revokes its own connection, and cannot revoke another owner\'s', async () => {
    const a = await owner('vault-revoke-owner-a'), b = await owner('vault-revoke-owner-b');
    await a.codeAge(60_000); await b.codeAge(60_000);
    await a.seedMcp('mcp-a', 'Owner A Notes');
    await b.seedMcp('mcp-b', 'Owner B Notes');
    await b.seedGoogle([{ id: 'conn-owner-b', email: 'owner-b@example.test', scopes: [] }]);
    // Owner A's cookie does not open owner B's object at all.
    expect((await b.stub.fetch(`${root}${DASHBOARD_VAULT_PATH}`, { headers: a.headers() })).status).toBe(401);
    const foreignGoogle = await a.act('connections', 'google.disconnect', 'conn-owner-b');
    expect(foreignGoogle.status).toBe(409);
    expect(await foreignGoogle.json()).toMatchObject({ error: 'no_longer_eligible' });
    const foreignMcp = await a.act('connections', 'mcp.disconnect', 'mcp-b');
    expect(foreignMcp.status).toBe(409);
    expect(await foreignMcp.json()).toMatchObject({ receipt: { state: 'rejected' } });
    const bVault = await (await b.vault()).json() as Vault;
    expect(bVault.connections.mcp.map(row => row.id)).toEqual(['mcp-b']);
    expect(bVault.connections.google.map(row => row.account_id)).toEqual(['conn-owner-b']);
    const own = await a.act('connections', 'mcp.disconnect', 'mcp-a');
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ receipt: { state: 'recorded' } });
    expect((await (await a.vault()).json() as Vault).connections.mcp).toEqual([]);
  });
});

describe('the Vault projection', () => {
  const memory = { version: 1 as const, state: 'available' as const, complete: true, claims: [], nodes: [], associations: [], unavailable_claim_count: 0, actions: [] };
  const base = { now: Date.parse('2026-10-26T10:00:00Z'), memory, google: [], mcp: [], telegram: { linked: false, unlinkAvailable: false },
    accessLog: { window_days: 30, kept_steps: 500, tools: { rows: [], next_before: null, oldest_at: null }, approvals: { rows: [], next_before: null } } };

  it('lists health sharing by source and purpose with grant dates and newest upload, never a value', () => {
    const vault = projectVault({ ...base, health: {
      consents: [{ source: 'apple', purpose: 'storage_compute', status: 'granted', granted_at: '2026-10-01T08:00:00Z', withdrawn_at: null }],
      sources: [{ source: 'apple', newest_upload_at: '2026-10-26T07:00:00Z' }],
    } });
    expect(vault.connections.health).toEqual({ state: 'available', manage: 'app', rows: [{ source: 'apple', purpose: 'storage_compute', status: 'granted', granted_at: '2026-10-01T08:00:00Z', withdrawn_at: null, newest_upload_at: '2026-10-26T07:00:00Z' }] });
  });

  it('keeps iMessage and WhatsApp unknown when the directory did not answer, and offers each unlink on its own view', () => {
    const unknown = projectVault({ ...base, health: null });
    expect(unknown.connections.channels.map(row => row.channel)).toEqual(['telegram']);
    const linked = projectVault({ ...base, health: null, telegram: { linked: true, unlinkAvailable: true }, imessage: { linked: true }, whatsapp: { linked: false } });
    expect(linked.connections.channels).toEqual([
      { channel: 'telegram', state: 'linked', revoke: { view: 'connections', action: 'telegram.unlink' } },
      { channel: 'imessage', state: 'linked', revoke: { view: 'imessage', action: 'imessage.unlink' } },
      { channel: 'whatsapp', state: 'unlinked', revoke: null },
    ]);
  });

  it('reads health sharing from consent_list and freshness_read only, keeping no score, count or extra field', async () => {
    const asked: string[] = [];
    let planted = false;
    const rpc = async (fn: string) => {
      asked.push(fn);
      if (fn === 'health_consent_list') return { consents: [{ consent_class: 'health_processing', source: 'apple', purpose: 'storage_compute', version: 2, status: 'granted', epoch: 1,
        granted_at: '2026-10-01T08:00:00.000Z', withdrawn_at: null, deletion_state: 'not_required', ...(planted ? { score: 87.5 } : {}) }] };
      return { freshness: { sources: [{ source: 'apple', newest_upload_at: '2026-10-26T07:00:00.000Z', uploads_7d: 173, rejected_readings_7d: [{ reason: 'invalid_sample', count: 9 }] }],
        refusals_7d: [], newest_derived: { day: '2026-10-26', compiled_at: '2026-10-26T07:30:00.000Z' } } };
    };
    const kv = memoryKv(), now = Date.parse('2026-10-26T10:00:00Z');
    const shared = await healthSharing({ rpc, doName: 'vault-health-owner', kv, now });
    expect(asked.sort()).toEqual(['health_consent_list', 'health_freshness_read']);
    expect(shared).toEqual({ consents: [{ source: 'apple', purpose: 'storage_compute', status: 'granted', granted_at: '2026-10-01T08:00:00.000Z', withdrawn_at: null }],
      sources: [{ source: 'apple', newest_upload_at: '2026-10-26T07:00:00.000Z' }] });
    const body = JSON.stringify(projectVault({ ...base, health: shared }));
    for (const value of ['173', 'invalid_sample', 'epoch', 'deletion_state', 'compiled_at', 'consent_class']) expect(body).not.toContain(value);
    // The consent contract is strict: a row carrying any field it does not name fails the whole section closed.
    planted = true;
    expect(await healthSharing({ rpc, doName: 'vault-health-owner', kv: memoryKv(), now })).toBeNull();
    expect(await healthSharing({ rpc: async () => { throw new Error('down'); }, doName: 'vault-health-owner', kv: memoryKv(), now })).toBeNull();
    expect(await healthSharing({ rpc: null, doName: 'vault-health-owner', kv: memoryKv(), now })).toBeNull();
  });

  it('spends the console health read budget, and leaves health unavailable without calling once it is spent', async () => {
    const asked: string[] = [];
    const rpc = async (fn: string) => { asked.push(fn); return { consents: [] }; };
    const now = Date.parse('2026-10-26T10:00:00Z'), kv = memoryKv();
    await healthSharing({ rpc, doName: 'vault-health-owner', kv, now });
    expect(kv.get<{ count: number }>('console:health-rate')).toEqual({ start: now, count: 1 });
    kv.put('console:health-rate', { start: now, count: HEALTH_READ_LIMIT });
    asked.length = 0;
    expect(await healthSharing({ rpc, doName: 'vault-health-owner', kv, now: now + 1_000 })).toBeNull();
    expect(asked).toEqual([]);
  });

  it('reads only the paging keys it names', () => {
    expect(readVaultQuery(new URLSearchParams())).toEqual({});
    expect(readVaultQuery(new URLSearchParams('tools_before=12&approvals_before=1793008800000.p00a'))).toEqual({ toolsBefore: 12, approvalsBefore: { at: 1793008800000, id: 'p00a' } });
    for (const bad of ['view=x', 'tools_before=-1', 'tools_before=1.5', 'approvals_before=', 'tools_before=1&tools_before=1']) expect(readVaultQuery(new URLSearchParams(bad)), bad).toBeNull();
  });
});
