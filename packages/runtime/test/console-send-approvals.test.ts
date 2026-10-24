import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { CONSOLE_ACTION_PATH, consoleAccess } from '../src/channels/console';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { emailProposal, sentMime } from './fixtures/email-send';

const proof = vi.hoisted(() => ({ telegram: [] as { method: string; body: any }[], sentRaw: [] as string[], logged: [] as string[] }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, body: any) => {
  proof.telegram.push({ method, body });
  return method === 'sendMessage' ? { message_id: proof.telegram.length, chat: { id: body.chat_id } } : method === 'getMe' ? { username: 'fixture_bot' } : true;
} }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: () => ({
    account: { connection_id: 'local:owner@example.test', email: 'owner@example.test' },
    sendRaw: async (raw: string) => { proof.sentRaw.push(raw); return { message_id: 'gmail-1', thread_id: 'thread-1' }; },
    findSentByMessageId: async (messageId: string) => proof.sentRaw.length ? { message_id: 'gmail-1', thread_id: 'thread-1', rfc822_message_id: messageId, label_ids: ['SENT'] } : false,
  }) };
});

type Waiting = { csrf: string; revision: string; data: { proposals: { id: string; kind: string; state: string; review: Record<string, unknown> | null; actions: string[] }[] } };

type Harness = Readonly<{
  instance: OwnerDO; state: DurableObjectState; token: string; cookie: Readonly<{ cookie: string }>; desk: any;
  read(): Promise<Waiting>;
  act(waiting: Waiting, action: string, id: string, request: string): Promise<{ status: number; text: string }>;
  row(id: string): { status: string; payload_json: string };
}>;

const withConsole = (label: string, body: (harness: Harness) => Promise<void>) => {
  const name = `${label}-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  return runInDurableObject(stub, async (_unused, state) => {
    const settings = { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', TELEGRAM_WEBHOOK_SECRET: 'fictional-webhook-secret', OPENAI_API_KEY: 'synthetic-model-key', WALDO_OWNER_TIMEZONE: 'UTC',
      GOOGLE_CLIENT_ID: 'fictional-client', GOOGLE_CLIENT_SECRET: 'fictional-secret', BROWSER: undefined };
    const instance = new OwnerDO(state, settings as never);
    state.storage.kv.put('do_name', name); state.storage.kv.put('origin', 'https://telegram-owner'); state.storage.kv.put('telegram_subject', '424242');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', scopes: null, refresh_token: 'fictional-not-a-token' }]);
    const token = await consoleAccess(state.storage).grant();
    const cookie = { cookie: `waldo_console=${token}` };
    const read = async () => { const response = await instance.fetch(new Request(`https://telegram-owner${CONTROLS_PATH}?view=waiting`, { headers: cookie })); expect(response.status).toBe(200); return response.json() as Promise<Waiting>; };
    const act = async (waiting: Waiting, action: string, id: string, request: string) => {
      const response = await instance.fetch(new Request(`https://telegram-owner${CONTROL_ACTION_PATH}`, { method: 'POST', headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: waiting.csrf, revision: waiting.revision, view: 'waiting', action, id, request_id: request }) }));
      return { status: response.status, text: await response.text() };
    };
    const desk = (instance as any).setup('telegram').desk;
    const row = (id: string) => state.storage.sql.exec<{ status: string; payload_json: string }>('SELECT status, payload_json FROM ledger WHERE id = ?', id).one();
    await body({ instance, state, token, cookie, desk, read, act, row });
  });
};

const draft = { to: ['sam@example.test'], cc: ['pat@example.test'], subject: 'PRIVATE-SUBJECT Friday', body: 'PRIVATE-BODY See you at four.\n\nRo', account: 'owner@example.test' };

it('the console Waiting view shows an email draft exactly, and approves, skips and changes it through the real action route', async () => {
  proof.telegram = []; proof.sentRaw = []; proof.logged = [];
  await withConsole('console-send-approvals', async ({ state, token, desk, read, act, row }) => {
    const logs = vi.spyOn(console, 'log').mockImplementation((...args) => { proof.logged.push(args.map(String).join(' ')); });
    const errors = vi.spyOn(console, 'error').mockImplementation((...args) => { proof.logged.push(args.map(String).join(' ')); });
    try {
      const sendId = await desk.proposeSendEmail(await emailProposal({ ...draft, message_id: '<console-send@waldo-send>' }));
      const skipId = await desk.proposeSendEmail(await emailProposal({ ...draft, subject: 'PRIVATE-SUBJECT skip', message_id: '<console-skip@waldo-send>' }));
      const editId = await desk.proposeSendEmail(await emailProposal({ ...draft, subject: 'PRIVATE-SUBJECT edit', message_id: '<console-edit@waldo-send>' }));

      const first = await read();
      const shown = first.data.proposals.find(item => item.id === sendId)!;
      expect(shown).toMatchObject({ kind: 'email_send', state: 'open', actions: ['approval.send', 'approval.edit', 'approval.skip'],
        review: { kind: 'email_send', account: 'owner@example.test', to: draft.to, cc: draft.cc, bcc: [], subject: draft.subject, body: draft.body } });

      // Sending as the owner needs an email code from the last two hours, so a copied session cookie cannot send.
      const codeAt = async (at: number) => {
        const sessions = (await state.storage.get<Record<string, Record<string, unknown>>>('console:sessions'))!;
        await state.storage.put('console:sessions', { ...sessions, [token]: { ...sessions[token]!, verified_at: at } });
      };
      await codeAt(Date.now() - 3 * 60 * 60_000);
      const unconfirmed = await act(first, 'approval.send', sendId, 'console-send-0000');
      expect([unconfirmed.status, JSON.parse(unconfirmed.text)]).toEqual([403, { error: 'step_up_required' }]);
      expect([proof.sentRaw, row(sendId).status]).toEqual([[], 'open']);
      await codeAt(Date.now());
      const approved = await act(first, 'approval.send', sendId, 'console-send-0001');
      expect([approved.status, JSON.parse(approved.text).receipt]).toEqual([200, { state: 'recorded', message: 'Sent. This cannot be undone.' }]);
      expect(proof.sentRaw).toHaveLength(1);
      expect(sentMime(proof.sentRaw[0]!).body).toBe(shown.review!.body);
      expect(row(sendId).status).toBe('done');
      // The read the decision was made on has moved, so an older read decides nothing.
      expect(JSON.parse((await act(first, 'approval.skip', skipId, 'console-skip-stale')).text)).toMatchObject({ error: 'stale_read' });

      const second = await read();
      const skipped = await act(second, 'approval.skip', skipId, 'console-skip-0001');
      expect([skipped.status, JSON.parse(skipped.text).receipt.state]).toEqual([200, 'recorded']);
      expect(row(skipId).status).toBe('skipped');

      const third = await read();
      const before = row(editId).payload_json;
      const changed = await act(third, 'approval.edit', editId, 'console-edit-0001');
      expect([changed.status, JSON.parse(changed.text).receipt]).toEqual([200, { state: 'recorded', message: 'Tell Waldo in the chat what to change.' }]);
      expect(row(editId)).toEqual({ status: 'changing', payload_json: before });
      const after = await read();
      expect(after.data.proposals.find(item => item.id === editId)).toBeUndefined();
      expect(proof.sentRaw).toHaveLength(1);
      for (const response of [approved, skipped, changed]) expect(response.text).not.toMatch(/PRIVATE-/);
      // The send's own hops reach the log, and none of them carries the draft.
      expect(proof.logged.some(line => line.includes('"hop":"email_send"'))).toBe(true);
      expect(proof.logged.join('\n')).not.toMatch(/PRIVATE-/);
    } finally { logs.mockRestore(); errors.mockRestore(); }
  });
});

it('warns on the console, as on the card, when an identical email may already have gone out', async () => {
  proof.telegram = []; proof.sentRaw = [];
  await withConsole('console-send-duplicate', async ({ state, desk, read }) => {
    const earlierId = await desk.proposeSendEmail(await emailProposal({ ...draft, message_id: '<console-earlier@waldo-send>' }));
    state.storage.sql.exec("UPDATE ledger SET status = 'uncertain', decided_at = ? WHERE id = ?", Date.now() - 60 * 60_000, earlierId);
    const againId = await desk.proposeSendEmail(await emailProposal({ ...draft, message_id: '<console-again@waldo-send>' }));
    const cards = proof.telegram.filter(call => call.method === 'sendMessage').map(call => String(call.body.text));
    const at = cards.map(text => /An identical email from (.+?) may already have gone out/.exec(text)?.[1]).find(Boolean);
    expect(at).toBeTruthy();
    const shown = (await read()).data.proposals.find(item => item.id === againId)!;
    expect([shown.actions, shown.review]).toEqual([['approval.send', 'approval.edit', 'approval.skip'], expect.objectContaining({ kind: 'email_send', earlier_unknown_at: at })]);
    const fresh = await desk.proposeSendEmail(await emailProposal({ ...draft, subject: 'PRIVATE-SUBJECT other', message_id: '<console-other@waldo-send>' }));
    expect((await read()).data.proposals.find(item => item.id === fresh)!.review).not.toHaveProperty('earlier_unknown_at');
  });
});

it('the classic console form refuses Send and Change it, and changes no card with them', async () => {
  await withConsole('console-classic-send', async ({ instance, state, token, cookie }) => {
    const csrf = (await state.storage.get<Record<string, { csrf: string }>>('console:sessions'))![token]!.csrf;
    const plan = () => state.storage.sql.exec('SELECT * FROM day_plan').toArray();
    await (instance as any).setup('telegram').ready;
    const before = plan();
    for (const action of ['approval.send', 'approval.edit']) {
      const response = await instance.fetch(new Request(`https://telegram-owner${CONSOLE_ACTION_PATH}`, { method: 'POST', headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, action, id: 'card:brief', value: '09:00' }) }));
      expect([action, await response.text()]).toEqual([action, expect.not.stringContaining('recorded')]);
    }
    expect(plan()).toEqual(before);
  });
});
