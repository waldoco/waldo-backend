import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { appApprovalDecisionResultV1Schema, appApprovalListV1Schema } from '../../contracts/src/app/approvals';
import { appApprovalsRequest } from '../src/channels/app-approvals';
import { appApprovalParts, approvalDesk, PROPOSAL_TTL_MS } from '../src/channels/approvals';
import { appApprovalLink, appCaller } from '../src/channels/surfaces/app';
import { sha256Hex, type GoogleClient } from '../src/connectors/google';

const CSRF = 'c'.repeat(64);

it('lists app approvals and decides them once against the reviewed digest, with durable receipts', async () => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`app-approvals-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_instance, state) => {
    let n = 0, sends = 0, eventTag = 'e1', current = 0;
    const client = {
      sendRaw: async () => { sends++; return { message_id: 'g1' }; },
      findSentByMessageId: async (id: string) => ({ message_id: 'g1', thread_id: 't', rfc822_message_id: id, label_ids: ['SENT'] }),
      createEvent: async () => ({ id: 'ev1', etag: 'e1' }),
      event: async () => ({ id: 'ev1', etag: eventTag, status: 'confirmed' }),
      cancelEvent: async () => undefined,
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, { surface: 'app', owner: 7_000_000_000_001, call: appCaller(), appLink: appApprovalLink,
      google: async () => client, newId: () => `app${++n}`, now: () => Date.now(), timezone: 'UTC', log: () => {}, currentRunRef: () => 'app-message-0001' });
    const host = { csrf: CSRF, expires: Date.now() + 3_600_000, storage: state.storage, assertCurrent: async () => { current++; }, sessions: async () => [{ csrf: CSRF, expires: Date.now() + 3_600_000 }], desk };
    const get = (query = '') => appApprovalsRequest(new Request(`https://telegram-owner/app/v1/approvals${query}`), host);
    const decide = (body: unknown) => appApprovalsRequest(new Request('https://telegram-owner/app/v1/approvals/decisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), host);
    const raw = 'To: a@x.test\r\nSubject: Hi\r\n\r\nSee you at four.';
    const id = await desk.proposeSendEmail({ to: ['a@x.test'], subject: 'Hi', body: 'See you at four.', message_id: '<app@waldo-send>', raw, digest: await sha256Hex(raw) });

    const listed = await get();
    expect(listed.status).toBe(200);
    const { approvals } = appApprovalListV1Schema.parse(await listed.json());
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ approval_id: id, kind: 'email_send', state: 'open', actions: ['approve', 'edit', 'skip', 'defer'], presented_surfaces: ['app'] });
    expect(current).toBeGreaterThanOrEqual(2);
    for (const query of ['?state=approved', '?state=open&state=done', '?limit=5', '?state=open&cursor=x']) expect([query, (await get(query)).status]).toEqual([query, 400]);
    expect(appApprovalListV1Schema.parse(await (await get('?state=done')).json()).approvals).toEqual([]);

    const decision = { approval_id: id, action: 'approve', expected_digest: approvals[0]!.payload_digest, request_id: 'decision-0001' };
    const stale = { ...decision, expected_digest: `sha256:${'0'.repeat(64)}`, request_id: 'decision-stale' };
    for (let i = 0; i < 2; i++) {
      const superseded = await decide(stale);
      expect(superseded.status).toBe(409);
      expect(appApprovalDecisionResultV1Schema.parse(await superseded.json())).toMatchObject({ request_id: 'decision-stale', receipt: { state: 'rejected' }, duplicate: false, approval_state: 'superseded' });
    }
    expect(Object.keys(await state.storage.get<Record<string, unknown>>('console:control-receipts') ?? {})).toEqual([]);
    expect(sends).toBe(0);

    const approved = await decide(decision);
    expect(approved.status).toBe(200);
    expect(appApprovalDecisionResultV1Schema.parse(await approved.json())).toMatchObject({ receipt: { state: 'recorded' }, duplicate: false, approval_state: 'done' });
    expect(sends).toBe(1);
    const again = await decide(decision);
    expect(again.status).toBe(200);
    expect(appApprovalDecisionResultV1Schema.parse(await again.json())).toMatchObject({ receipt: { state: 'recorded' }, duplicate: true, approval_state: 'done' });
    expect(sends).toBe(1);
    expect((await decide({ ...decision, action: 'skip' })).status).toBe(409);
    expect(await (await decide({ ...decision, action: 'skip' })).json()).toMatchObject({ error: 'request_reused' });
    const ineligible = await decide({ ...decision, request_id: 'decision-0002' });
    expect([ineligible.status, (await ineligible.json() as { error: string }).error]).toEqual([409, 'no_longer_eligible']);
    expect(sends).toBe(1);
    expect((await decide({ ...decision, request_id: 'short' })).status).toBe(400);
    expect((await decide({ ...decision, surface: 'telegram' })).status).toBe(400);
    expect((await decide({ ...decision, approval_id: 'pmissing', request_id: 'decision-0003' })).status).toBe(404);
    expect((await appApprovalsRequest(new Request('https://telegram-owner/app/v1/approvals/decisions', { method: 'POST', body: '{' }), host)).status).toBe(400);

    const calendar = await desk.propose({ action: 'create', title: 'Walk', start: new Date(Date.now() + 3_600_000).toISOString() as never, end: new Date(Date.now() + 5_400_000).toISOString() as never, reason: 'afternoon slot' });
    const [walk] = appApprovalListV1Schema.parse(await (await get('?state=open')).json()).approvals;
    const done = await decide({ approval_id: calendar, action: 'approve', expected_digest: walk!.payload_digest, request_id: 'calendar-0001' });
    expect(appApprovalDecisionResultV1Schema.parse(await done.json())).toMatchObject({ receipt: { state: 'recorded' }, approval_state: 'done' });
    eventTag = 'e2';
    const undo = await decide({ approval_id: calendar, action: 'undo', expected_digest: walk!.payload_digest, request_id: 'calendar-0002' });
    expect(undo.status).toBe(409);
    expect(appApprovalDecisionResultV1Schema.parse(await undo.json())).toMatchObject({ receipt: { state: 'rejected' }, approval_state: 'done' });
  });
});

it('app receipts carry fixed text, never provider errors or the desk message', async () => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`app-approvals-receipts-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_instance, state) => {
    let n = 0, providerDown = true;
    const client = { sendRaw: async () => ({ message_id: 'g1' }), findSentByMessageId: async (id: string) => ({ message_id: 'g1', thread_id: 't', rfc822_message_id: id, label_ids: ['SENT'] }) } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, { surface: 'app', owner: 7_000_000_000_001, call: appCaller(), newId: () => `rcpt${++n}`, now: () => Date.now(), timezone: 'UTC', log: () => {},
      google: async () => { if (providerDown) throw new Error('PROVIDER-SECRET invalid_grant for owner@example.test'); return client; } });
    const host = { csrf: CSRF, expires: Date.now() + 3_600_000, storage: state.storage, assertCurrent: async () => {}, sessions: async () => [{ csrf: CSRF, expires: Date.now() + 3_600_000 }], desk };
    const decide = async (body: unknown) => { const response = await appApprovalsRequest(new Request('https://telegram-owner/app/v1/approvals/decisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), host); return { status: response.status, text: await response.text() }; };
    const raw = 'To: a@x.test\r\nSubject: Hi\r\n\r\nPRIVATE-BODY-TEXT';
    const id = await desk.proposeSendEmail({ to: ['a@x.test'], subject: 'Hi', body: 'PRIVATE-BODY-TEXT', message_id: '<rcpt@waldo-send>', raw, digest: await sha256Hex(raw) });
    const [item] = await desk.approvals(Date.now(), { id });
    const failed = await decide({ approval_id: id, action: 'approve', expected_digest: item!.payload_digest, request_id: 'receipt-0001' });
    expect(failed.status).toBe(409);
    expect(JSON.parse(failed.text)).toMatchObject({ receipt: { state: 'rejected', message: 'That did not work. Nothing else ran.' }, approval_state: 'open' });
    providerDown = false;
    const sent = await decide({ approval_id: id, action: 'approve', expected_digest: item!.payload_digest, request_id: 'receipt-0002' });
    expect(JSON.parse(sent.text)).toMatchObject({ receipt: { state: 'recorded', message: 'Sent. This cannot be undone.' }, approval_state: 'done' });
    for (const body of [failed.text, sent.text]) expect(body).not.toMatch(/PROVIDER-SECRET|invalid_grant|owner@example\.test|PRIVATE-BODY-TEXT|a@x\.test/);
  });
});

it('Not now keeps the approval open and its cards live, leaves it out of the default list, and a later decision by id still works', async () => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`app-approvals-defer-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_instance, state) => {
    let n = 0, sends = 0;
    const client = { sendRaw: async () => { sends++; return { message_id: 'g1' }; }, findSentByMessageId: async (id: string) => ({ message_id: 'g1', thread_id: 't', rfc822_message_id: id, label_ids: ['SENT'] }) } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, { surface: 'app', owner: 7_000_000_000_002, call: appCaller(), appLink: appApprovalLink,
      google: async () => client, newId: () => `defer${++n}`, now: () => Date.now(), timezone: 'UTC', log: () => {}, currentRunRef: () => 'app-message-0002' });
    const host = { csrf: CSRF, expires: Date.now() + 3_600_000, storage: state.storage, assertCurrent: async () => {}, sessions: async () => [{ csrf: CSRF, expires: Date.now() + 3_600_000 }], desk };
    const decide = (body: unknown) => appApprovalsRequest(new Request('https://telegram-owner/app/v1/approvals/decisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), host);
    const list = async (query = '') => appApprovalListV1Schema.parse(await (await appApprovalsRequest(new Request(`https://telegram-owner/app/v1/approvals${query}`), host)).json()).approvals;
    const raw = 'To: b@x.test\r\nSubject: Later\r\n\r\nNot today.';
    const id = await desk.proposeSendEmail({ to: ['b@x.test'], subject: 'Later', body: 'Not today.', message_id: '<defer@waldo-send>', raw, digest: await sha256Hex(raw) });
    const [item] = await list();
    expect(item).toMatchObject({ approval_id: id, state: 'open' });
    expect(item!.actions).toContain('defer');
    expect(appApprovalParts(state.storage.sql)('app-message-0002').live.map(part => part.actions)).toEqual([item!.actions]);

    const body = { approval_id: id, action: 'defer', expected_digest: item!.payload_digest, request_id: 'defer-request-0001' };
    const deferred = await decide(body);
    expect(deferred.status).toBe(200);
    expect(appApprovalDecisionResultV1Schema.parse(await deferred.json())).toMatchObject({ duplicate: false, approval_state: 'open', receipt: { state: 'recorded', message: 'Left it for later. It is still waiting, and it can still expire.' } });
    expect(await list()).toEqual([]);
    expect((await list('?state=open')).map(approval => [approval.approval_id, approval.state])).toEqual([[id, 'open']]);
    expect(appApprovalDecisionResultV1Schema.parse(await (await decide(body)).json())).toMatchObject({ duplicate: true, approval_state: 'open' });
    expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM approval_presentations WHERE approval_id = ? AND retired_at IS NOT NULL', id).one().n).toBe(0);
    expect(sends).toBe(0);

    const sent = await decide({ approval_id: id, action: 'approve', expected_digest: item!.payload_digest, request_id: 'defer-request-0002' });
    expect(appApprovalDecisionResultV1Schema.parse(await sent.json())).toMatchObject({ approval_state: 'done', receipt: { state: 'recorded' } });
    expect(sends).toBe(1);
    expect((await list()).map(approval => [approval.approval_id, approval.state])).toEqual([[id, 'done']]);
    const late = await decide({ ...body, request_id: 'defer-request-0003' });
    expect([late.status, (await late.json() as { error: string }).error]).toEqual([409, 'no_longer_eligible']);
  });
});

it('a Not now the desk did not take is answered as not done, and the approval stays in the default list', async () => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`app-approvals-defer-refused-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_instance, state) => {
    let n = 0;
    const client = { sendRaw: async () => ({ message_id: 'g1' }) } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, { surface: 'app', owner: 7_000_000_000_004, call: appCaller(), appLink: appApprovalLink,
      google: async () => client, newId: () => `refused${++n}`, now: () => Date.now(), timezone: 'UTC', log: () => {}, currentRunRef: () => 'app-message-0004' });
    // A decision that raced this one: the desk answers that the row was already handled.
    const raced = { approvals: desk.approvals, decide: async () => ({ toast: 'Already handled.', message: 'Already handled.' }) };
    const host = { csrf: CSRF, expires: Date.now() + 3_600_000, storage: state.storage, assertCurrent: async () => {}, sessions: async () => [{ csrf: CSRF, expires: Date.now() + 3_600_000 }], desk: raced };
    const raw = 'To: d@x.test\r\nSubject: Race\r\n\r\nRaced.';
    const id = await desk.proposeSendEmail({ to: ['d@x.test'], subject: 'Race', body: 'Raced.', message_id: '<race@waldo-send>', raw, digest: await sha256Hex(raw) });
    const list = async () => appApprovalListV1Schema.parse(await (await appApprovalsRequest(new Request('https://telegram-owner/app/v1/approvals'), host)).json()).approvals;
    const [item] = await list();
    const answer = await appApprovalsRequest(new Request('https://telegram-owner/app/v1/approvals/decisions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approval_id: id, action: 'defer', expected_digest: item!.payload_digest, request_id: 'refused-request-0001' }) }), host);
    expect(answer.status).toBe(409);
    expect(appApprovalDecisionResultV1Schema.parse(await answer.json())).toMatchObject({ approval_state: 'open', receipt: { state: 'rejected' } });
    expect((await list()).map(approval => approval.approval_id)).toEqual([id]);
  });
});

// One app owner's desk on a clock the test moves, with the app's approvals routes over it.
const deferDesk = async <T>(name: string, run: (tools: Readonly<{ desk: ReturnType<typeof approvalDesk>; clock: { at: number }; sql: SqlStorage;
  decide(body: unknown): Promise<Response>; list(query?: string): Promise<ReturnType<typeof appApprovalListV1Schema.parse>['approvals']>;
  propose(subject: string, body: string): Promise<string>; deferredAt(id: string): number | null }>) => Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), async (_instance, state) => {
    let n = 0;
    const clock = { at: Date.now() };
    const client = { sendRaw: async () => ({ message_id: 'g1' }) } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, { surface: 'app', owner: 7_000_000_000_006, call: appCaller(), appLink: appApprovalLink,
      google: async () => client, newId: () => `${name}${++n}`, now: () => clock.at, timezone: 'UTC', log: () => {}, currentRunRef: () => 'app-message-0006' });
    const host = { csrf: CSRF, expires: Date.now() + 3_600_000, storage: state.storage, assertCurrent: async () => {}, sessions: async () => [{ csrf: CSRF, expires: Date.now() + 3_600_000 }], desk };
    return run({ desk, clock, sql: state.storage.sql,
      decide: body => appApprovalsRequest(new Request('https://telegram-owner/app/v1/approvals/decisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), host),
      list: async (query = '') => appApprovalListV1Schema.parse(await (await appApprovalsRequest(new Request(`https://telegram-owner/app/v1/approvals${query}`), host)).json()).approvals,
      propose: async (subject, body) => {
        const raw = `To: e@x.test\r\nSubject: ${subject}\r\n\r\n${body}`;
        return desk.proposeSendEmail({ to: ['e@x.test'], subject, body, message_id: `<${subject.toLowerCase()}@waldo-send>`, raw, digest: await sha256Hex(raw) });
      },
      deferredAt: id => state.storage.sql.exec<{ deferred_at: number | null }>('SELECT deferred_at FROM ledger WHERE id = ?', id).one().deferred_at });
  });

it('a second Not now is refused, offered by neither the list nor the desk, and keeps the first deferral', async () => {
  await deferDesk('defer-twice', async ({ desk, clock, decide, list, propose, deferredAt }) => {
    const id = await propose('Twice', 'Once is enough.');
    const [item] = await list();
    const first = await decide({ approval_id: id, action: 'defer', expected_digest: item!.payload_digest, request_id: 'twice-request-0001' });
    expect(first.status).toBe(200);
    const at = deferredAt(id);
    expect(at).toBe(clock.at);
    clock.at += 60_000;
    const [deferred] = await list('?state=open');
    expect(deferred!.actions).not.toContain('defer');
    const again = await decide({ approval_id: id, action: 'defer', expected_digest: item!.payload_digest, request_id: 'twice-request-0002' });
    expect(again.status).toBe(409);
    expect((await desk.decide(id, 'd', 'app:approval', { surface: 'app' })).toast).toBe('Already handled.');
    expect(deferredAt(id)).toBe(at);
  });
});

it('Not now on a review-only approval is recorded, keeps it review-only, and leaves it out of the default list', async () => {
  await deferDesk('defer-review-only', async ({ decide, list, propose, deferredAt }) => {
    const id = await propose('Huge', 'y'.repeat(33_000));
    const [item] = await list();
    expect(item).toMatchObject({ approval_id: id, state: 'review_only', actions: ['skip', 'defer'] });
    const answer = await decide({ approval_id: id, action: 'defer', expected_digest: item!.payload_digest, request_id: 'review-request-0001' });
    expect(answer.status).toBe(200);
    expect(appApprovalDecisionResultV1Schema.parse(await answer.json())).toMatchObject({ approval_state: 'review_only', receipt: { state: 'recorded' } });
    expect(deferredAt(id)).not.toBeNull();
    expect(await list()).toEqual([]);
    expect((await list('?state=review_only')).map(approval => approval.approval_id)).toEqual([id]);
  });
});

it('Not now on an approval past its expiry expires it and records no deferral', async () => {
  await deferDesk('defer-expired', async ({ clock, decide, list, propose, deferredAt }) => {
    const id = await propose('Stale', 'Too late now.');
    const [item] = await list();
    clock.at += PROPOSAL_TTL_MS + 60_000;
    const answer = await decide({ approval_id: id, action: 'defer', expected_digest: item!.payload_digest, request_id: 'stale-request-0001' });
    expect(answer.status).toBe(409);
    expect(appApprovalDecisionResultV1Schema.parse(await answer.json())).toMatchObject({ approval_state: 'expired', receipt: { state: 'rejected' } });
    expect(deferredAt(id)).toBeNull();
  });
});

it('adds the deferral column to a ledger created before it, once, and keeps the rows', async () => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`app-approvals-defer-column-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`CREATE TABLE ledger (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL,
      undo_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)`);
    sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at) VALUES ('p-old', 'email_send', 'skipped', 'old', '{}', 1)");
    const deps = { surface: 'app' as const, owner: 7_000_000_000_003, call: appCaller(), google: async () => ({}) as GoogleClient, newId: () => 'x', now: () => Date.now(), timezone: 'UTC', log: () => {} };
    approvalDesk(sql, deps); approvalDesk(sql, deps);
    expect(sql.exec<{ name: string; type: string }>('PRAGMA table_info(ledger)').toArray().filter(column => column.name === 'deferred_at').map(column => column.type)).toEqual(['INTEGER']);
    expect(sql.exec<{ id: string; deferred_at: number | null }>('SELECT id, deferred_at FROM ledger').toArray()).toEqual([{ id: 'p-old', deferred_at: null }]);
  });
});
