import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk, PROPOSAL_TTL_MS, UNDO_WINDOW_MS } from '../src/channels/approvals';
import { GoogleError, type GoogleClient } from '../src/connectors/google';

const iso = (s: string) => s as never;

describe('approval desk', () => {
  it('browser_submit: proposes with Do it / Not now, executes ONLY on approve, never undoes, expires in 30 minutes', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-browser'));
    await runInDurableObject(stub, async (_instance, state) => {
      const sent: { method: string; body: Record<string, unknown> }[] = [];
      let now = 1_000_000;
      let n = 0;
      const executed: string[] = [];
      const payload = {
        url: 'https://shop.example/checkout',
        action: { selector: '#pay', description: 'Place the order', method: 'click' },
        binding: { total: 'Rs 499', items: '1x bottle' },
        steps: ['Add to cart'],
      };
      const desk = approvalDesk(state.storage.sql, {
        call: async (method, body) => { sent.push({ method, body: body as Record<string, unknown> }); return {}; },
        owner: 42, google: async () => null, newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
        browserSubmit: async (p) => { executed.push(p.action.description); return 'Done: Place the order.'; },
      });
      const id = await desk.proposeBrowserSubmit(payload);
      expect(sent[0]!.body.text).toBe('Approve this browser action? Place the order on https://shop.example/checkout (total: Rs 499, items: 1x bottle)');
      const keyboard = JSON.stringify(sent[0]!.body.reply_markup);
      expect(keyboard).toContain(`a:${id}`);
      expect(keyboard).toContain(`s:${id}`);
      expect(keyboard).not.toContain(`e:${id}`);
      expect(executed).toEqual([]);

      // double-decide safe
      await desk.callback({ id: 'q1', from: { id: 42 }, data: `a:${id}` }, 't');
      await desk.callback({ id: 'q2', from: { id: 42 }, data: `a:${id}` }, 't');
      expect(executed).toEqual(['Place the order']);

      // never undoable
      const undone = await desk.decide(id, 'u', 't');
      expect(undone.toast).toBe("Can't be undone");

      // 30-minute TTL, not the 12-hour calendar one
      const id2 = await desk.proposeBrowserSubmit({ ...payload, action: { ...payload.action, description: 'Pay now' } });
      now += 31 * 60_000;
      const late = await desk.decide(id2, 'a', 't');
      expect(late.toast).toBe('This proposal expired');
      expect(executed).toHaveLength(1);

      // no executor configured -> honest refusal, nothing executes
      const desk2 = approvalDesk(state.storage.sql, {
        call: async (method, body) => { sent.push({ method, body: body as Record<string, unknown> }); return {}; },
        owner: 42, google: async () => null, newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
      });
      const id3 = await desk2.proposeBrowserSubmit({ ...payload, action: { ...payload.action, description: 'Confirm booking' } });
      const noExec = await desk2.decide(id3, 'a', 't');
      expect(noExec.toast).toBe('Browsing is not set up');
    });
  });

  it('sends a card, applies only on Approve, undoes within the window, and keeps a ledger', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-desk'));
    await runInDurableObject(stub, async (_instance, state) => {
      const sent: { method: string; body: Record<string, unknown> }[] = [];
      const google: string[] = [];
      let now = 1_000_000;
      let n = 0;
      const client = {
        event: async (id: string) => ({ id, title: 'Gym', start: '2026-09-23T18:00:00+05:30', end: '2026-09-23T19:00:00+05:30', all_day: false }),
        moveEvent: async (id: string, start: string) => { google.push(`move ${id} ${start}`); return { id, title: 'Gym', start, end: start, all_day: false }; },
        createEvent: async () => { google.push('create'); return { id: 'new1', title: 'x', start: '', end: '', all_day: false }; },
        cancelEvent: async (id: string) => { google.push(`cancel ${id}`); },
      } as unknown as GoogleClient;
      const desk = approvalDesk(state.storage.sql, {
        call: async (method, body) => { sent.push({ method, body: body as Record<string, unknown> }); return {}; },
        owner: 42, google: async () => client, newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
      });
      const id = await desk.propose({ action: 'move', event_id: 'e1', title: 'Gym', start: iso('2026-09-23T19:00:00+05:30'), end: iso('2026-09-23T20:00:00+05:30'), reason: 'you have a call at 6' });
      expect(sent[0]!.body.text).toBe('Proposed: Move "Gym" to Wed 23 Sept, 19:00 to Wed 23 Sept, 20:00. you have a call at 6');
      expect(JSON.stringify(sent[0]!.body.reply_markup)).toContain(`a:${id}`);
      expect(google).toEqual([]);

      await desk.callback({ id: 'q0', from: { id: 7 }, data: `a:${id}` }, 't');
      expect(google).toEqual([]);

      await desk.callback({ id: 'q1', from: { id: 42 }, data: `a:${id}`, message: { message_id: 5, chat: { id: 42 } } }, 't');
      expect(google).toEqual(['move e1 2026-09-23T19:00:00+05:30']);
      expect(sent.some((s) => s.method === 'editMessageReplyMarkup')).toBe(true);
      await desk.callback({ id: 'q2', from: { id: 42 }, data: `a:${id}` }, 't');
      expect(google).toHaveLength(1);

      now += UNDO_WINDOW_MS - 1;
      await desk.callback({ id: 'q3', from: { id: 42 }, data: `u:${id}` }, 't');
      expect(google.at(-1)).toBe('move e1 2026-09-23T18:00:00+05:30');

      const skip = await desk.propose({ action: 'cancel', event_id: 'e2', title: 'Sync', reason: 'clash' });
      await desk.callback({ id: 'q4', from: { id: 42 }, data: `s:${skip}` }, 't');
      expect(google).toHaveLength(2);

      const late = await desk.propose({ action: 'create', title: 'Walk', start: iso('2026-09-24T07:00:00+05:30'), end: iso('2026-09-24T07:30:00+05:30'), reason: 'morning slot' });
      await desk.callback({ id: 'q5', from: { id: 42 }, data: `a:${late}` }, 't');
      now += UNDO_WINDOW_MS + 1;
      await desk.callback({ id: 'q6', from: { id: 42 }, data: `u:${late}` }, 't');
      expect(google.at(-1)).toBe('create');

      desk.record('email_draft', 'Drafted "Hi" to a@example.com', {});
      const open = await desk.propose({ action: 'cancel', event_id: 'e3', title: 'Standup', reason: 'sick' });
      const ledger = desk.ledger([{ note: 'water', at: '2026-09-24T09:00', repeat: 'daily' }]);
      expect(ledger).toContain('- Cancel "Standup". sick (waiting on you)');
      expect(ledger).toContain('- 2026-09-24 09:00 water (daily)');
      expect(ledger).toContain('- undone: Move "Gym"');
      expect(ledger).toContain('- skipped: Cancel "Sync"');
      expect(ledger).toContain('- done: Drafted "Hi" to a@example.com');
      expect(open).toMatch(/^p/);
    });
  });

  it('never applies an expired proposal or one whose event changed since the card', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-stale'));
    await runInDurableObject(stub, async (_instance, state) => {
      const texts: string[] = [];
      const google: string[] = [];
      let now = 1_000_000;
      let n = 0;
      let etag = 'v1';
      let conflict = false;
      const client = {
        event: async (id: string) => ({ id, title: 'Gym', start: '2026-09-23T18:00:00+05:30', end: '2026-09-23T19:00:00+05:30', all_day: false, etag }),
        moveEvent: async (id: string, start: string, _end: string, match?: string) => {
          if (conflict) throw new GoogleError(412, 'google 412: precondition failed');
          google.push(`move ${id} ${start} ${match}`);
          return { id, title: 'Gym', start, end: start, all_day: false };
        },
        cancelEvent: async (id: string, match?: string) => { google.push(`cancel ${id} ${match}`); },
      } as unknown as GoogleClient;
      const desk = approvalDesk(state.storage.sql, {
        call: async (_method, body) => { texts.push(String((body as { text?: string }).text ?? '')); return {}; },
        owner: 42, google: async () => client, newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
      });
      const tap = (id: string) => desk.callback({ id: 'q', from: { id: 42 }, data: `a:${id}` }, 't');
      const move = { action: 'move' as const, event_id: 'e1', title: 'Gym', start: iso('2026-09-23T19:00:00+05:30'), end: iso('2026-09-23T20:00:00+05:30'), reason: 'clash' };

      const old = await desk.propose(move);
      now += PROPOSAL_TTL_MS + 1;
      await tap(old);
      expect(google).toEqual([]);
      expect(texts.at(-1)).toContain('That proposal expired');

      const edited = await desk.propose(move);
      etag = 'v2';
      await tap(edited);
      expect(google).toEqual([]);
      expect(texts.at(-1)).toContain('The event changed in your calendar');

      const raced = await desk.propose(move);
      conflict = true;
      await tap(raced);
      expect(google).toEqual([]);
      expect(texts.at(-1)).toContain('The event changed in your calendar');

      conflict = false;
      const fresh = await desk.propose(move);
      await tap(fresh);
      expect(google).toEqual(['move e1 2026-09-23T19:00:00+05:30 v2']);
      expect(desk.ledger([])).toContain('- stale: Move "Gym"');
      expect(desk.ledger([])).toContain('- expired: Move "Gym"');
    });
  });

  it('console path: pending lists open proposals, decide applies/skips without Telegram, double-decide is safe', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-console'));
    await runInDurableObject(stub, async (_instance, state) => {
      const google: string[] = [];
      let now = 1_000_000;
      let n = 0;
      const client = {
        event: async (id: string) => ({ id, title: 'Gym', start: '2026-09-23T18:00:00+05:30', end: '2026-09-23T19:00:00+05:30', all_day: false }),
        moveEvent: async (id: string, start: string) => { google.push(`move ${id} ${start}`); return { id, title: 'Gym', start, end: start, all_day: false }; },
        createEvent: async () => { google.push('create'); return { id: 'new1', title: 'x', start: '', end: '', all_day: false }; },
        cancelEvent: async (id: string) => { google.push(`cancel ${id}`); },
      } as unknown as GoogleClient;
      const desk = approvalDesk(state.storage.sql, {
        call: async () => ({}),
        owner: 42, google: async () => client, newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
      });
      expect(desk.pending(now)).toEqual([]);
      const id = await desk.propose({ action: 'move', event_id: 'e1', title: 'Gym', start: iso('2026-09-23T19:00:00+05:30'), end: iso('2026-09-23T20:00:00+05:30'), reason: 'call at 6' });
      const listed = desk.pending(now);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id, state: 'open', undoable: false });
      expect(listed[0]!.summary).toContain('Move "Gym"');

      // The console decision applies the change with no Telegram round-trip.
      const out = await desk.decide(id, 'a', 'console:approval');
      expect(out.toast).toBe('Done');
      expect(out.message).toContain('Undo is available');
      expect(google).toEqual(['move e1 2026-09-23T19:00:00+05:30']);

      // Double decision (telegram tap after console click) does not re-apply.
      const again = await desk.decide(id, 'a', 'console:approval');
      expect(again.toast).toBe('Already handled.');
      expect(google).toHaveLength(1);

      // The done item shows as undoable inside the window, and undo works from the console path.
      const done = desk.pending(now).find((item) => item.id === id);
      expect(done).toMatchObject({ state: 'done', undoable: true });
      const undone = await desk.decide(id, 'u', 'console:approval');
      expect(undone.toast).toBe('Undone');
      expect(google.at(-1)).toBe('move e1 2026-09-23T18:00:00+05:30');

      // Skip path: nothing applied, no undo offered.
      const skip = await desk.propose({ action: 'cancel', event_id: 'e2', title: 'Sync', reason: 'clash' });
      const skipped = await desk.decide(skip, 's', 'console:approval');
      expect(skipped.toast).toBe('Not now');
      expect(google).toHaveLength(2);
      expect(desk.pending(now).some((item) => item.id === skip)).toBe(false);
    });
  });
});

describe('approval desk - email_send rail', () => {
  const proposal = {
    to: ['a@x.test'], subject: 'Hello', body: 'Body text', message_id: '<m1@waldo-send>',
    raw: 'To: a@x.test\r\nSubject: Hello\r\nMessage-ID: <m1@waldo-send>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\nBody text',
    digest: '',
  };
  let idSeq = 0;
  const setup = async (state: DurableObjectState, opts: { sendError?: Error; found?: boolean; findError?: Error; connected?: boolean; messageId?: string }) => {
    const sent: { method: string; body: Record<string, unknown> }[] = [];
    const sentRaw: string[] = [];
    let now = 1_000_000;
    let n = 0;
    const client = {
      sendRaw: async (raw: string) => { sentRaw.push(raw); if (opts.sendError) throw opts.sendError; return { message_id: 'g1' }; },
      findSentByMessageId: async () => { if (opts.findError) throw opts.findError; return opts.found ?? false; },
    } as unknown as GoogleClient;
    const googleIntents: (string | undefined)[] = [];
    const desk = approvalDesk(state.storage.sql, {
      call: async (method, body) => { sent.push({ method, body: body as Record<string, unknown> }); return {}; },
      owner: 42, google: async (sendIntent?: string) => { googleIntents.push(sendIntent); return opts.connected === false ? null : client; }, newId: () => String(++idSeq), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
    });
    const { sha256Hex } = await import('../src/connectors/google');
    const id = await desk.proposeSendEmail({ ...proposal, ...(opts.messageId !== undefined ? { message_id: opts.messageId } : {}), digest: await sha256Hex(proposal.raw) });
    return { desk, id, sent, sentRaw, googleIntents, sql: state.storage.sql, tick: (ms: number) => { now += ms; } };
  };

  it('proposes with Send it / Modify / Not now, sends the exact stored bytes on approve, never undoes, expires', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-1'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sent, sentRaw, tick } = await setup(state, {});
      expect(sent[0]!.body.text).toBe('Send this email? Send email to a@x.test: "Hello"');
      const keyboard = JSON.stringify(sent[0]!.body.reply_markup);
      expect(keyboard).toContain(`a:${id}`);
      expect(keyboard).toContain(`e:${id}`);
      expect(sentRaw).toEqual([]);

      const out = await desk.decide(id, 'a', 't');
      expect(out.toast).toBe('Sent');
      expect(sentRaw).toEqual([proposal.raw]);
      expect((await desk.decide(id, 'u', 't')).toast).toBe("Can't be undone");
      expect(desk.pending(Date.now()).find((p) => p.id === id)?.undoable ?? false).toBe(false);

      const id2 = await desk.proposeSendEmail({ ...proposal, digest: await (await import('../src/connectors/google')).sha256Hex(proposal.raw) });
      tick(13 * 60 * 60_000);
      const late = await desk.decide(id2, 'a', 't');
      expect(late.toast).toBe('This proposal expired');
      expect(sentRaw).toHaveLength(1);
    });
  });

  it('binds the proxy send idempotency gate to the approved proposal id, never to content alone', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-intent'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, googleIntents } = await setup(state, {});
      await desk.decide(id, 'a', 't');
      expect(googleIntents).toEqual([`email_send:${id}`]);
    });
  });

  it('fails closed when stored bytes no longer match the approved digest - nothing sends', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-2'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sentRaw, sql } = await setup(state, {});
      // tamper: rewrite the stored recipient after approval was requested
      const row = sql.exec<{ payload_json: string }>('SELECT payload_json FROM ledger WHERE id = ?', id).toArray()[0]!;
      const tampered = JSON.parse(row.payload_json) as Record<string, unknown>;
      tampered.raw = String(tampered.raw).replace('a@x.test', 'attacker@evil.test');
      sql.exec('UPDATE ledger SET payload_json = ? WHERE id = ?', JSON.stringify(tampered), id);
      const out = await desk.decide(id, 'a', 't');
      expect(out.toast).toBe('Email changed');
      expect(sentRaw).toEqual([]);
    });
  });

  it('reconciles an ambiguous send through Sent mail: exactly-once, never a blind retry', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-3'));
    await runInDurableObject(stub, async (_i, state) => {
      const ok = await setup(state, { sendError: new Error('network timeout'), found: true });
      const out1 = await ok.desk.decide(ok.id, 'a', 't');
      expect(out1.toast).toBe('Sent');
      expect(out1.message).toContain('exactly once');
      expect(ok.sentRaw).toHaveLength(1);

      const miss = await setup(state, { sendError: new Error('network timeout'), found: false });
      const out2 = await miss.desk.decide(miss.id, 'a', 't');
      expect(out2.toast).toBe("That didn't send");
      expect(out2.message).toContain('Nothing was delivered');
      expect(miss.sentRaw).toHaveLength(1);
    });
  });

  it('refuses honestly when Google is not connected', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-4'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sentRaw } = await setup(state, { connected: false });
      const out = await desk.decide(id, 'a', 't');
      expect(out.toast).toBe('Google is not connected');
      expect(sentRaw).toEqual([]);
    });
  });

  it('a retry of the same email returns the same proposal id, re-sends the same card, and two approvals send exactly once', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-retry'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sent, sentRaw, sql } = await setup(state, {});
      const { sha256Hex } = await import('../src/connectors/google');
      // ambiguous timeout after the first card: the tool loop retries with identical bytes
      const again = await desk.proposeSendEmail({ ...proposal, digest: await sha256Hex(proposal.raw) });
      expect(again).toBe(id); // no second proposal, no fresh Message-ID
      const rows = sql.exec("SELECT * FROM ledger WHERE kind = 'email_send' AND status = 'open'").toArray();
      expect(rows).toHaveLength(1);
      const cards = sent.filter((m) => m.method === 'sendMessage');
      expect(cards).toHaveLength(2); // the card is re-sent in case the first timed out
      expect(JSON.stringify(cards[1]!.body.reply_markup)).toContain(`a:${id}`); // same id behind both cards

      // approving BOTH visible cards (same id) sends exactly one email
      const first = await desk.decide(id, 'a', 't');
      const second = await desk.decide(id, 'a', 't');
      expect(first.toast).toBe('Sent');
      expect(second.toast).toBe('Already handled.');
      expect(sentRaw).toEqual([proposal.raw]);
    });
  });

  it('an ambiguous send whose reconciliation itself fails is typed unknown - never claims non-delivery', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-unknown'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sentRaw, sql } = await setup(state, { sendError: new Error('network timeout'), findError: new Error('gmail search failed') });
      const out = await desk.decide(id, 'a', 't');
      expect(out.toast).toBe('Send unconfirmed');
      expect(out.message).toContain('may be in your Sent folder');
      expect(out.message).not.toContain('Nothing was delivered');
      expect(sentRaw).toHaveLength(1);
      const row = sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).toArray()[0]!;
      expect(row.status).toBe('unknown');
    });
  });

  it('a proposal with an empty Message-ID cannot reconcile - typed unknown, honest wording', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-noid'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sentRaw, sql } = await setup(state, { sendError: new Error('network timeout'), messageId: '' });
      const out = await desk.decide(id, 'a', 't');
      expect(out.toast).toBe('Send unconfirmed');
      expect(out.message).toContain('check there before asking me to resend');
      expect(sentRaw).toHaveLength(1);
      const row = sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).toArray()[0]!;
      expect(row.status).toBe('unknown');
    });
  });
});
