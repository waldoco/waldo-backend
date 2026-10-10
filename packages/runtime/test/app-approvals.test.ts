import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { appApprovalDecisionResultV1Schema, appApprovalListV1Schema } from '../../contracts/src/app/approvals';
import { appApprovalsRequest } from '../src/channels/app-approvals';
import { approvalDesk } from '../src/channels/approvals';
import { appApprovalLink, appApprovalPart, appCaller } from '../src/channels/surfaces/app';
import { sha256Hex, type GoogleClient } from '../src/connectors/google';

const CSRF = 'c'.repeat(64);

it('lists app approvals and decides them once against the reviewed digest, with durable receipts', async () => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`app-approvals-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_instance, state) => {
    let n = 0, sends = 0, eventTag = 'e1', current = 0;
    const client = {
      sendRaw: async () => { sends++; return { message_id: 'g1' }; },
      findSentByMessageId: async (id: string) => ({ message_id: 'g1', thread_id: 't', rfc822_message_id: id, label_ids: ['SENT'] }),
      createEvent: async () => ({ id: 'ev1', etag: 'e1' }),
      event: async () => ({ id: 'ev1', etag: eventTag, status: 'confirmed' }),
      cancelEvent: async () => undefined,
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, { surface: 'app', owner: 7_000_000_000_001, call: appCaller(), appJournal: appApprovalPart, appLink: appApprovalLink,
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
    expect(approvals[0]).toMatchObject({ approval_id: id, kind: 'email_send', state: 'open', actions: ['approve', 'edit', 'skip'], presented_surfaces: ['app'] });
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
