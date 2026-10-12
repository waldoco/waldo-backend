import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { appApprovalListV1Schema } from '../../contracts/src/app/approvals';
import { appApprovalsRequest } from '../src/channels/app-approvals';
import { appApprovalParts, approvalDesk, PROPOSAL_TTL_MS } from '../src/channels/approvals';
import { appApprovalLink, appCaller } from '../src/channels/surfaces/app';
import { sha256Hex, type GoogleClient } from '../src/connectors/google';
import { approvalHandlers } from '../src/tools/live/raise-approval';
import { receiptsFromLoopEvents } from '../src/hooks/claim-hook';

const CSRF = 'c'.repeat(64);
type Sent = { method: string; body: { text?: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } } };

// One owner DO with a desk on the given surface. The Telegram fake records every call and acknowledges sends unless told to drop them.
const deskOn = async <T>(surface: 'app' | 'telegram' | 'whatsapp', name: string, run: (tools: Readonly<{
  desk: ReturnType<typeof approvalDesk>; clock: { at: number }; runRef: { current: string | undefined }; sql: SqlStorage; sent: Sent[]; telegram: { deliver: boolean };
  raise(args: unknown): Promise<{ ok: boolean; data?: Record<string, unknown> }>;
  list(query?: string): Promise<ReturnType<typeof appApprovalListV1Schema.parse>['approvals']>;
  propose(subject: string, body?: string): Promise<string>; deferredAt(id: string): number | null; shownCount(id: string): number;
}>) => Promise<T>) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), async (_instance, state) => {
    let n = 0;
    const clock = { at: Date.now() }, runRef = { current: 'app-message-0006' as string | undefined }, sent: Sent[] = [], telegram = { deliver: true };
    const client = { sendRaw: async () => ({ message_id: 'g1' }) } as unknown as GoogleClient;
    const call = surface === 'app' ? appCaller() : async (method: string, body: unknown) => {
      sent.push({ method, body: body as Sent['body'] });
      return method === 'sendMessage' ? (telegram.deliver ? { message_id: sent.length, chat: { id: 42 } } : undefined) : true;
    };
    const desk = approvalDesk(state.storage.sql, { surface, owner: surface === 'app' ? 7_000_000_000_006 : 42, call, appLink: appApprovalLink,
      google: async () => client, newId: () => `${name}${++n}`, now: () => clock.at, timezone: 'UTC', log: () => {},
      currentRunRef: () => runRef.current ?? 'scope-run-0001', appReplyRef: () => runRef.current });
    const host = { csrf: CSRF, expires: Date.now() + 3_600_000, storage: state.storage, assertCurrent: async () => {}, sessions: async () => [{ csrf: CSRF, expires: Date.now() + 3_600_000 }], desk };
    const handler = approvalHandlers(desk).find(candidate => candidate.name === 'raise_approval')!;
    return run({ desk, clock, runRef, sql: state.storage.sql, sent, telegram,
      raise: async args => await handler.handle(handler.schema.parse(args) as never) as never,
      list: async (query = '') => appApprovalListV1Schema.parse(await (await appApprovalsRequest(new Request(`https://telegram-owner/app/v1/approvals${query}`), host)).json()).approvals,
      propose: async (subject, body = 'A short note.') => {
        const raw = `To: e@x.test\r\nSubject: ${subject}\r\n\r\n${body}`;
        return desk.proposeSendEmail({ to: ['e@x.test'], subject, body, message_id: `<${subject.toLowerCase()}@waldo-send>`, raw, digest: await sha256Hex(raw) });
      },
      deferredAt: id => state.storage.sql.exec<{ deferred_at: number | null }>('SELECT deferred_at FROM ledger WHERE id = ?', id).one().deferred_at,
      shownCount: id => state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM approval_presentations WHERE approval_id = ?', id).one().count });
  });

const keyboard = (message: Sent | undefined) => message?.body.reply_markup?.inline_keyboard.flat().map(button => `${button.text}=${button.callback_data.split(':')[0]}`);

it('on the app, a raised approval is back in the list with Not now again, and its card is on the reply to this run', async () => {
  await deskOn('app', 'raise-app', async ({ desk, runRef, sql, raise, list, propose, deferredAt }) => {
    const id = await propose('Later');
    expect((await desk.decide(id, 'd', 'app:approval', { surface: 'app' })).toast).toBe('Later');
    expect(await list()).toEqual([]);
    expect(desk.ledger([])).toContain('(waiting on you; put off for later)');
    runRef.current = 'app-message-0007';
    const listed = await raise({ operation: 'list' });
    expect(listed.data).toMatchObject({ approvals: [{ approval_id: id, kind: 'email_send', state: 'open', put_off: true }] });
    const raised = await raise({ operation: 'raise', approval_id: id });
    expect(raised).toMatchObject({ ok: true, data: { approval_id: id, outcome: 'raised', shown_on: ['app'], on_this_reply: true } });
    expect(deferredAt(id)).toBeNull();
    const [item] = await list();
    expect(item).toMatchObject({ approval_id: id, state: 'open', actions: ['approve', 'edit', 'skip', 'defer'] });
    expect(appApprovalParts(sql)('app-message-0007').live).toMatchObject([{ approval_id: id, actions: ['approve', 'edit', 'skip', 'defer'] }]);
    expect((await raise({ operation: 'list' })).data).toMatchObject({ approvals: [{ approval_id: id, put_off: false }] });
    expect(desk.ledger([])).not.toContain('put off');
  });
});

it('a second raise in the same run sends nothing: the approval is no longer put off', async () => {
  await deskOn('app', 'raise-twice', async ({ desk, runRef, raise, propose, shownCount }) => {
    const id = await propose('Twice');
    await desk.decide(id, 'd', 'app:approval', { surface: 'app' });
    runRef.current = 'app-message-0008';
    const [first, second] = await Promise.all([raise({ operation: 'raise', approval_id: id }), raise({ operation: 'raise', approval_id: id })]);
    expect([first.data?.outcome, second.data?.outcome].sort()).toEqual(['not_put_off', 'raised']);
    expect(shownCount(id)).toBe(2);
    expect((await raise({ operation: 'raise', approval_id: id })).data).toMatchObject({ outcome: 'not_put_off' });
    expect(shownCount(id)).toBe(2);
  });
});

it('an approval past its expiry is expired, never shown again, and never listed as waiting', async () => {
  await deskOn('app', 'raise-expired', async ({ desk, clock, raise, propose, shownCount, sql }) => {
    const id = await propose('Stale');
    await desk.decide(id, 'd', 'app:approval', { surface: 'app' });
    clock.at += PROPOSAL_TTL_MS + 60_000;
    expect((await raise({ operation: 'list' })).data).toEqual({ approvals: [] });
    expect((await raise({ operation: 'raise', approval_id: id })).data).toMatchObject({ approval_id: id, outcome: 'expired' });
    expect(sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('expired');
    expect(shownCount(id)).toBe(1);
  });
});

it('nothing is sent for an approval that is decided, unknown, or not put off', async () => {
  await deskOn('app', 'raise-refused', async ({ desk, raise, propose, shownCount }) => {
    const skipped = await propose('Skipped'), open = await propose('Open');
    await desk.decide(skipped, 's', 'app:approval', { surface: 'app' });
    expect((await raise({ operation: 'raise', approval_id: skipped })).data).toMatchObject({ outcome: 'not_waiting' });
    expect((await raise({ operation: 'raise', approval_id: 'pmissing' })).data).toMatchObject({ outcome: 'not_waiting' });
    expect((await raise({ operation: 'raise', approval_id: open })).data).toMatchObject({ outcome: 'not_put_off' });
    expect([shownCount(skipped), shownCount(open)]).toEqual([1, 1]);
  });
});

it('raised in scheduled work (a run, but no app chat reply), the approval is back in the list and the model is not told a card is on its reply', async () => {
  await deskOn('app', 'raise-no-run', async ({ desk, runRef, sql, raise, list, propose }) => {
    const id = await propose('Background');
    await desk.decide(id, 'd', 'app:approval', { surface: 'app' });
    runRef.current = undefined;
    expect((await raise({ operation: 'raise', approval_id: id })).data).toMatchObject({ outcome: 'raised', on_this_reply: false });
    expect((await list()).map(item => item.approval_id)).toEqual([id]);
    expect(appApprovalParts(sql)('scope-run-0001').live).toEqual([]);
  });
});

it('on Telegram, Not now defers and keeps the card decidable, Don\'t do this skips, and a raise sends a fresh card', async () => {
  await deskOn('telegram', 'raise-telegram', async ({ desk, sent, raise, propose, deferredAt, sql }) => {
    const id = await propose('Tg');
    const card = sent.find(message => message.method === 'sendMessage');
    expect(keyboard(card)).toEqual(['Send it=a', 'Modify=e', 'Not now=d', "Don't do this=s"]);
    await desk.callback({ id: 'q1', from: { id: 42 }, data: `d:${id}`, message: { message_id: 1, chat: { id: 42 } } }, 't');
    expect(sent.find(message => message.method === 'answerCallbackQuery')?.body.text).toBe('Later');
    expect(deferredAt(id)).not.toBeNull();
    expect(keyboard(sent.filter(message => message.method === 'editMessageReplyMarkup').at(-1))).toEqual(['Send it=a', 'Modify=e', "Don't do this=s"]);
    const before = sent.filter(message => message.method === 'sendMessage').length;
    expect((await raise({ operation: 'raise', approval_id: id })).data).toMatchObject({ outcome: 'raised', shown_on: ['telegram'], on_this_reply: false });
    const fresh = sent.filter(message => message.method === 'sendMessage');
    expect(fresh.length).toBe(before + 1);
    expect(keyboard(fresh.at(-1))).toEqual(['Send it=a', 'Modify=e', 'Not now=d', "Don't do this=s"]);
    await desk.callback({ id: 'q2', from: { id: 42 }, data: `s:${id}`, message: { message_id: fresh.length, chat: { id: 42 } } }, 't');
    expect(sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('skipped');
    expect(sent.filter(message => message.method === 'answerCallbackQuery').at(-1)?.body.text).toBe('Skipped');
  });
});

it('a raise whose card cannot be sent leaves the approval put off', async () => {
  await deskOn('telegram', 'raise-unsent', async ({ desk, telegram, raise, propose, deferredAt }) => {
    const id = await propose('Unsent');
    await desk.decide(id, 'd', 't', { surface: 'telegram' });
    const at = deferredAt(id);
    telegram.deliver = false;
    expect((await raise({ operation: 'raise', approval_id: id })).data).toMatchObject({ outcome: 'unshown' });
    expect(deferredAt(id)).toBe(at);
  });
});

it('a review-only Telegram card offers Not now and Don\'t do this', async () => {
  await deskOn('telegram', 'raise-review-only', async ({ sent, propose }) => {
    await propose('Huge', 'y'.repeat(5_000));
    expect(keyboard(sent.find(message => message.method === 'sendMessage'))).toEqual(['Not now=d', "Don't do this=s"]);
  });
});

it('on WhatsApp, a raise sends a fresh card and the model is told so', async () => {
  await deskOn('whatsapp', 'raise-whatsapp', async ({ desk, sent, raise, propose }) => {
    const id = await propose('Wa');
    await desk.decide(id, 'd', 't', { surface: 'whatsapp' });
    const before = sent.filter(message => message.method === 'sendMessage').length;
    expect((await raise({ operation: 'raise', approval_id: id })).data).toMatchObject({ outcome: 'raised', shown_on: ['whatsapp'], note: 'A fresh card with its buttons was sent to the owner.' });
    expect(sent.filter(message => message.method === 'sendMessage').length).toBe(before + 1);
  });
});

it('a raise backs no done claim: listing or raising changes nothing outside the desk', () => {
  expect(receiptsFromLoopEvents([
    { seq: 1, call: { name: 'raise_approval', args: { operation: 'list' } }, ok: true },
    { seq: 2, call: { name: 'raise_approval', args: { operation: 'raise', approval_id: 'p1' } }, ok: true },
  ] as never)).toEqual([]);
});
