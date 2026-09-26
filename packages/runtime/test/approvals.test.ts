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
        owner: 42, google: async () => ({ client, connection: 'conn-test' }), newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
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
        owner: 42, google: async () => ({ client, connection: 'conn-test' }), newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
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
        owner: 42, google: async () => ({ client, connection: 'conn-test' }), newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
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
    digest: '', content_digest: 'cd1',
  };
  let idSeq = 0;
  const setup = async (state: DurableObjectState, opts: { sendError?: Error; found?: boolean; findError?: Error; connected?: boolean; messageId?: string; failFirstCard?: boolean; googleError?: Error; pinUnavailable?: boolean; undelivered?: boolean }) => {
    const sent: { method: string; body: Record<string, unknown> }[] = [];
    const sentRaw: string[] = [];
    const sentRawArgCounts: number[] = [];
    let now = 1_000_000;
    let n = 0;
    const client = {
      sendRaw: async (...args: [string, string?]) => { sentRawArgCounts.push(args.length); sentRaw.push(args[0]); if (opts.sendError) throw opts.sendError; return { message_id: 'g1' }; },
      findSentByMessageId: async () => { if (opts.findError) throw opts.findError; return opts.found ?? false; },
    } as unknown as GoogleClient;
    const googleIntents: (string | undefined)[] = [];
    const googleCorrelations: (string | undefined)[] = [];
    const googlePins: (string | undefined)[] = [];
    const desk = approvalDesk(state.storage.sql, {
      call: async (method, body) => {
        sent.push({ method, body: body as Record<string, unknown> });
        // Egress gate blocks the send: the gate resolves undefined (no channel receipt).
        if (opts.undelivered) return undefined;
        // A real ambiguous Telegram failure: the FIRST approval card send throws after Telegram
        // may have applied it server-side; later sends succeed.
        if (opts.failFirstCard && method === 'sendMessage' && String((body as { text?: string }).text).startsWith('Send this email?')) {
          opts.failFirstCard = false;
          throw new Error('telegram send timeout');
        }
        return {};
      },
      owner: 42, google: async (sendIntent?: string, correlation?: string, pinned?: string) => { googleIntents.push(sendIntent); googleCorrelations.push(correlation); googlePins.push(pinned); if (opts.googleError) { const e = opts.googleError; opts.googleError = undefined; throw e; } if (opts.pinUnavailable && pinned) return null; return opts.connected === false ? null : { client, connection: 'conn-test' }; }, newId: () => String(++idSeq), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
    });
    const { sha256Hex } = await import('../src/connectors/google');
    const proposed = await desk.proposeSendEmail({ ...proposal, ...(opts.messageId !== undefined ? { message_id: opts.messageId } : {}), digest: await sha256Hex(proposal.raw) });
    if (!proposed.ok) throw new Error(`unexpected proposal failure: ${proposed.reason}`);
    return { desk, id: proposed.id, delivered: proposed.delivered, sent, sentRaw, sentRawArgCounts, googleIntents, googleCorrelations, googlePins, sql: state.storage.sql, tick: (ms: number) => { now += ms; } };
  };

  it('omits an absent thread id from the approved send RPC arguments', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-no-thread'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sentRawArgCounts } = await setup(state, {});
      expect((await desk.decide(id, 'a', 't')).toast).toBe('Sent');
      expect(sentRawArgCounts).toEqual([1]);
    });
  });

  it('proposes with Send it / Modify / Not now, sends the exact stored bytes on approve, never undoes, expires', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-1'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sent, sentRaw, tick } = await setup(state, {});
      expect(sent[0]!.body.text).toBe('Send this email? To: a@x.test\nSubject: Hello\n\nBody text');
      const keyboard = JSON.stringify(sent[0]!.body.reply_markup);
      expect(keyboard).toContain(`a:${id}`);
      expect(keyboard).toContain(`e:${id}`);
      expect(sentRaw).toEqual([]);

      const out = await desk.decide(id, 'a', 't');
      expect(out.toast).toBe('Sent');
      expect(sentRaw).toEqual([proposal.raw]);
      expect((await desk.decide(id, 'u', 't')).toast).toBe("Can't be undone");
      expect(desk.pending(Date.now()).find((p) => p.id === id)?.undoable ?? false).toBe(false);

      const second = await desk.proposeSendEmail({ ...proposal, digest: await (await import('../src/connectors/google')).sha256Hex(proposal.raw) });
      if (!second.ok) throw new Error('unexpected proposal failure');
      const id2 = second.id;
      tick(13 * 60 * 60_000);
      const late = await desk.decide(id2, 'a', 't');
      expect(late.toast).toBe('This proposal expired');
      expect(sentRaw).toHaveLength(1);
    });
  });

  it('shows From and resolved To, then fails closed if the proposal-time sender pin was revoked', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-self-pin'));
    await runInDurableObject(stub, async (_i, state) => {
      const run = await setup(state, { pinUnavailable: true });
      await run.desk.decide(run.id, 's', 't');
      const proposed = await run.desk.proposeSendEmail({
        ...proposal, from: 'owner@example.com', sender_connection: 'conn-revoked',
        to: ['owner@example.com'], content_digest: 'self-pin',
      });
      if (!proposed.ok) throw new Error('proposal unexpectedly failed');
      expect(run.sent.at(-1)?.body.text).toContain('Sending account: owner@example.com\nTo: owner@example.com');
      const out = await run.desk.decide(proposed.id, 'a', 't');
      expect(out.toast).toBe('Account unavailable');
      expect(run.googlePins.at(-1)).toBe('conn-revoked');
      expect(run.sentRaw).toEqual([]);
      expect(run.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', proposed.id).toArray()[0]?.status).toBe('open');
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
      expect(out1.toast).toBe('Found in Sent');
      expect(out1.message).toContain('in your Sent folder');
      expect(out1.message).not.toContain('exactly once'); // a Sent hit proves a matching item, never exactly-once delivery
      expect(ok.sentRaw).toHaveLength(1);

      // A single negative Sent lookup proves NOTHING (index lag / ambiguous network): the
      // outcome stays unknown and the owner is told to check Sent before any resend.
      const miss = await setup(state, { sendError: new Error('network timeout'), found: false });
      const out2 = await miss.desk.decide(miss.id, 'a', 't');
      expect(out2.toast).toBe('Send unconfirmed');
      expect(out2.message).toContain('may be in your Sent folder');
      expect(out2.message).not.toContain('Nothing was delivered');
      expect(miss.sentRaw).toHaveLength(1);
    });
  });

  it('two concurrent approvals race on the atomic claim: exactly one reaches sendRaw', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-concurrent'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sentRaw, sql } = await setup(state, {});
      // Start both approvals WITHOUT awaiting the first: both read status open before either
      // reaches provider I/O. The synchronous open -> sending claim lets exactly one through.
      const [a, b] = await Promise.all([desk.decide(id, 'a', 't1'), desk.decide(id, 'a', 't2')]);
      const toasts = [a.toast, b.toast].sort();
      expect(toasts).toEqual(['Already handled.', 'Sent']);
      expect(sentRaw).toEqual([proposal.raw]);
      expect(sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('done');
    });
  });

  it('refuses honestly when Google is not connected', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-4'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sentRaw, sql } = await setup(state, { connected: false });
      const out = await desk.decide(id, 'a', 't');
      expect(out.toast).toBe('Google is not connected');
      expect(sentRaw).toEqual([]);
      // claimed but never attempted: the proposal is released back to open for a connected retry
      expect(sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('open');
    });
  });

  it('after an ambiguous Telegram card timeout, the retry returns the same proposal id, re-sends the same card, and two approvals send exactly once', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-retry'));
    await runInDurableObject(stub, async (_i, state) => {
      // The first card send really throws (Telegram may have applied it server-side).
      const first = await setup(state, { failFirstCard: true }).catch((error: unknown) => error);
      expect(first).toBeInstanceOf(Error); // the ambiguous timeout propagates; no success was claimed
      // The tool loop retries with identical bytes (same logical send, same Message-ID).
      const { sha256Hex } = await import('../src/connectors/google');
      const sent: { method: string; body: Record<string, unknown> }[] = [];
      const sentRaw: string[] = [];
      const client = {
        sendRaw: async (raw: string) => { sentRaw.push(raw); return { message_id: 'g1' }; },
        findSentByMessageId: async () => false,
      } as unknown as GoogleClient;
      let n = 0;
      const desk = approvalDesk(state.storage.sql, {
        call: async (method, body) => { sent.push({ method, body: body as Record<string, unknown> }); return {}; },
        owner: 42, google: async () => ({ client, connection: 'conn-test' }), newId: () => String(++n), now: () => 1_000_000, timezone: 'Asia/Kolkata', log: () => undefined,
      });
      const firstProposal = await desk.proposeSendEmail({ ...proposal, digest: await sha256Hex(proposal.raw) });
      if (!firstProposal.ok) throw new Error('unexpected proposal failure');
      const { id, reused } = firstProposal;
      expect(reused).toBe('open');
      const rows = state.storage.sql.exec<{ id: string }>("SELECT id FROM ledger WHERE kind = 'email_send'").toArray();
      expect(rows).toHaveLength(1); // no second proposal, no fresh Message-ID
      expect(id).toBe(rows[0]!.id); // the retry returned the SAME row the timed-out propose created
      const cards = sent.filter((m) => m.method === 'sendMessage');
      expect(cards).toHaveLength(1);
      expect(JSON.stringify(cards[0]!.body.reply_markup)).toContain(`a:${id}`); // the card rides the same id

      // approving twice (the owner may see the first card too) sends exactly one email
      const approved = await desk.decide(id, 'a', 't');
      const duplicate = await desk.decide(id, 'a', 't');
      expect(approved.toast).toBe('Sent');
      expect(duplicate.toast).toBe('Already handled.');
      expect(sentRaw).toEqual([proposal.raw]);
    });
  });

  it('same-content sends on separate intents never collapse, and an old Sent hit never marks a later failed send delivered', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-distinct'));
    await runInDurableObject(stub, async (_i, state) => {
      const sentRaw: string[] = [];
      let failNext = false;
      const sentIds: string[] = [];
      const client = {
        sendRaw: async (raw: string) => { sentRaw.push(raw); if (failNext) { failNext = false; throw new Error('network timeout'); } return { message_id: 'g1' }; },
        // Sent contains only the FIRST logical send's Message-ID, like Gmail would after it landed.
        findSentByMessageId: async (mid: string) => sentIds.includes(mid),
      } as unknown as GoogleClient;
      let n = 0;
      const desk = approvalDesk(state.storage.sql, {
        call: async () => ({}),
        owner: 42, google: async () => ({ client, connection: 'conn-test' }), newId: () => String(++n), now: () => 1_000_000, timezone: 'Asia/Kolkata', log: () => undefined,
      });
      const { sha256Hex } = await import('../src/connectors/google');
      // Two separate intents, identical content, distinct Message-IDs (as the turn-scoped key produces).
      const first = { ...proposal, message_id: '<turn1@waldo-send>', raw: proposal.raw.replace('<m1@waldo-send>', '<turn1@waldo-send>') };
      const second = { ...proposal, message_id: '<turn2@waldo-send>', raw: proposal.raw.replace('<m1@waldo-send>', '<turn2@waldo-send>') };
      const p1 = await desk.proposeSendEmail({ ...first, digest: await sha256Hex(first.raw) });
      const p2 = await desk.proposeSendEmail({ ...second, digest: await sha256Hex(second.raw) });
      if (!p1.ok || !p2.ok) throw new Error('unexpected proposal failure');
      const id1 = p1.id;
      const id2 = p2.id;
      expect(id2).not.toBe(id1); // distinct intents -> two proposals
      expect(state.storage.sql.exec("SELECT * FROM ledger WHERE kind = 'email_send' AND status = 'open'").toArray()).toHaveLength(2);

      // First intent sends fine and lands in Sent under its own Message-ID.
      sentIds.push(first.message_id);
      expect((await desk.decide(id1, 'a', 't')).toast).toBe('Sent');
      // Second intent: the send errors ambiguously. Reconciliation must NOT match the older
      // send's Message-ID and falsely report delivered.
      failNext = true;
      const out = await desk.decide(id2, 'a', 't');
      expect(out.toast).toBe('Send unconfirmed'); // an old Sent hit must not mark it delivered
      expect(out.message).not.toContain('exactly once');
      expect(sentRaw).toEqual([first.raw, second.raw]);
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

  it('an unreconciled unknown send blocks a same-content re-entry - no new proposal, no duplicate risk', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-reentry'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sent } = await setup(state, { sendError: new Error('network timeout'), found: false });
      const out = await desk.decide(id, 'a', 't');
      expect(out.toast).toBe('Send unconfirmed');
      const { sha256Hex } = await import('../src/connectors/google');
      const cardsBefore = sent.filter((m) => m.method === 'sendMessage').length;

      // A NEW turn proposes identical content under a fresh Message-ID: the unreconciled
      // 'unknown' row blocks it - no second proposal the owner could approve into a duplicate.
      const retry = await desk.proposeSendEmail({ ...proposal, message_id: '<turn2@waldo-send>', digest: await sha256Hex(proposal.raw) });
      if (!retry.ok) throw new Error('unexpected proposal failure');
      expect(retry.reused).toBe('unknown');
      expect(retry.id).toBe(id);
      // A row minted before mailbox-identity digests existed must still block a reconnect
      // from proposing the same bytes with the new digest format.
      const upgraded = await desk.proposeSendEmail({
        ...proposal, from: 'owner@example.com', sender_connection: 'new-connection',
        content_digest: 'new-mailbox-aware-digest', message_id: '<turn3@waldo-send>',
        digest: await sha256Hex(proposal.raw),
      });
      expect(upgraded).toMatchObject({ ok: true, reused: 'unknown', id });
      const rows = state.storage.sql.exec("SELECT id FROM ledger WHERE kind = 'email_send'").toArray();
      expect(rows).toHaveLength(1);
      // No new approval card (no Send it buttons the owner could approve into a duplicate) -
      // but the owner IS told how to resolve the unreconciled send: one resolution message
      // carrying Check Sent / It did not go buttons, per the recovery-gap fix.
      const after = sent.filter((m) => m.method === 'sendMessage');
      expect(after).toHaveLength(cardsBefore + 2);
      const resolution = after[after.length - 1]!.body as { text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } };
      expect(resolution.text).toContain('still unconfirmed');
      expect(resolution.reply_markup?.inline_keyboard[0]?.map((b) => b.callback_data)).toEqual([`r:${id}`, `x:${id}`]);
      expect(JSON.stringify(resolution)).not.toContain(`a:${id}`); // never a second approvable card
    });
  });

  it('a same-turn retry while a send is in flight (sending) mints nothing', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-inflight'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sent } = await setup(state, {});
      const { sha256Hex } = await import('../src/connectors/google');
      // The row sits mid-claim, as after the atomic open -> sending flip before provider I/O.
      state.storage.sql.exec("UPDATE ledger SET status = 'sending' WHERE id = ?", id);
      const cardsBefore = sent.filter((m) => m.method === 'sendMessage').length;
      const retry = await desk.proposeSendEmail({ ...proposal, digest: await sha256Hex(proposal.raw) });
      if (!retry.ok) throw new Error('unexpected proposal failure');
      expect(retry.reused).toBe('sending');
      expect(retry.id).toBe(id);
      expect(state.storage.sql.exec("SELECT id FROM ledger WHERE kind = 'email_send'").toArray()).toHaveLength(1);
      expect(sent.filter((m) => m.method === 'sendMessage')).toHaveLength(cardsBefore);
    });
  });

  it('a confirmed same-content send on a new intent still gets its own proposal', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-resolved'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id } = await setup(state, {});
      expect((await desk.decide(id, 'a', 't')).toast).toBe('Sent'); // reconciled: status done
      const { sha256Hex } = await import('../src/connectors/google');
      const again = await desk.proposeSendEmail({ ...proposal, message_id: '<turn2@waldo-send>', digest: await sha256Hex(proposal.raw) });
      if (!again.ok) throw new Error('unexpected proposal failure');
      expect(again.reused).toBe(null); // no unresolved outcome -> legit repeat intent proceeds
      expect(again.id).not.toBe(id);
    });
  });

  it('fails closed with typed preview_oversize when the complete card cannot fit Telegram - no row, no card', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-oversize'));
    await runInDurableObject(stub, async (_i, state) => {
      const big = { ...proposal, body: 'x'.repeat(10_000) };
      const { sha256Hex } = await import('../src/connectors/google');
      const sentCards: string[] = [];
      const desk = approvalDesk(state.storage.sql, {
        call: async (method, body) => { sentCards.push(`${method}:${String((body as { text?: string }).text ?? '')}`); return {}; },
        owner: 42, google: async () => null, newId: () => 'ov1', now: () => 1_000_000, timezone: 'Asia/Kolkata', log: () => undefined,
      });
      const result = await desk.proposeSendEmail({ ...big, digest: await sha256Hex(big.raw) });
      expect(result).toMatchObject({ ok: false, reason: 'preview_oversize' });
      if (!result.ok) {
        expect(result.limit).toBe(4096);
        expect(result.actual).toBeGreaterThan(4096);
      }
      expect(state.storage.sql.exec("SELECT id FROM ledger WHERE kind = 'email_send'").toArray()).toHaveLength(0);
      expect(sentCards.filter((c) => c.startsWith('sendMessage:'))).toHaveLength(0);
    });
  });

  it('releases the claim back to open when client build throws before any provider I/O - no stranded sending row', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-claim-release'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sentRaw, sql } = await setup(state, { googleError: new Error('vault adopt failed') });
      const out = await desk.decide(id, 'a', 't');
      expect(out.toast).toBe('That failed');
      expect(out.message).toContain('vault adopt failed');
      expect(sentRaw).toHaveLength(0); // no provider I/O happened
      const row = sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).toArray()[0]!;
      expect(row.status).toBe('open'); // released for a clean retry, not stranded as sending
      const retry = await desk.decide(id, 'a', 't');
      expect(retry.toast).toBe('Sent');
      expect(sentRaw).toHaveLength(1);
    });
  });

  it('an unreconciled send is owner-visible in pending() and resolves via Check Sent or It did not go', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-unknown-resolve'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, googleIntents, googleCorrelations } = await setup(state, { sendError: new Error('network timeout'), found: false });
      const out = await desk.decide(id, 'a', 't');
      expect(out.toast).toBe('Send unconfirmed');
      expect(out.buttons).toEqual([['Check Sent', `r:${id}`], ['I checked Sent - not there', `x:${id}`]]);
      // owner-visible: unknown rows are listed as pending work
      expect(desk.pending(1_000_000).some((item) => item.id === id && item.state === 'unknown')).toBe(true);
      // deliberate reconciliation goes through the MAIL connection: the intent id is non-empty
      // so the owner-DO wiring selects feature=mail, never a calendar-scoped account
      const miss = await desk.decide(id, 'r', 't');
      expect(miss.toast).toBe('Not in Sent yet');
      expect(miss.buttons).toEqual([['Check Sent', `r:${id}`], ['I checked Sent - not there', `x:${id}`]]);
      expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).toArray()[0]!.status).toBe('unknown');
      expect(googleIntents[googleIntents.length - 1]).toBe(`email_send:${id}`);
      // the turn trace id rides as the proxy correlation key, joining EF logs to this turn
      expect(googleCorrelations[googleCorrelations.length - 1]).toBe('t');
      // owner declares it did not go -> closed, and a fresh same-content proposal mints a new card
      const closed = await desk.decide(id, 'x', 't');
      expect(closed.toast).toBe('Marked as not sent');
      expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).toArray()[0]!.status).toBe('failed');
      expect(desk.pending(1_000_000).some((item) => item.id === id)).toBe(false);
      const { sha256Hex } = await import('../src/connectors/google');
      const fresh = await desk.proposeSendEmail({ ...proposal, message_id: '<turn2@waldo-send>', digest: await sha256Hex(proposal.raw) });
      if (!fresh.ok) throw new Error('unexpected proposal failure');
      expect(fresh.reused).toBe(null);
      expect(fresh.id).not.toBe(id);
    });
  });

  it('an unknown send past the 12h TTL still reconciles and still blocks duplicates', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-unknown-ttl'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sql, tick } = await setup(state, { sendError: new Error('network timeout'), found: false });
      expect((await desk.decide(id, 'a', 't')).toast).toBe('Send unconfirmed');
      tick(13 * 60 * 60_000); // past the 12h proposal TTL
      // reconciliation is not a proposal action: it must NOT expire
      const recheck = await desk.decide(id, 'r', 't');
      expect(recheck.toast).toBe('Not in Sent yet');
      expect(sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).toArray()[0]!.status).toBe('unknown');
      // and the possibly-delivered send still blocks a duplicate proposal
      const { sha256Hex } = await import('../src/connectors/google');
      const dupe = await desk.proposeSendEmail({ ...proposal, message_id: '<turn2@waldo-send>', digest: await sha256Hex(proposal.raw) });
      expect(dupe.ok).toBe(true);
      if (dupe.ok) { expect(dupe.reused).toBe('unknown'); expect(dupe.id).toBe(id); }
      // owner declaration past the TTL still closes the row
      expect((await desk.decide(id, 'x', 't')).toast).toBe('Marked as not sent');
      expect(sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).toArray()[0]!.status).toBe('failed');
    });
  });

  it('a gated (blocked) card send keeps the row but never claims a visible card', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-undelivered'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, delivered, sql } = await setup(state, { undelivered: true });
      // the FIRST proposal kept the row but reported no visible card (no channel receipt)
      expect(delivered).toBe(false);
      const again = await desk.proposeSendEmail({ ...proposal, digest: await (await import('../src/connectors/google')).sha256Hex(proposal.raw) });
      expect(again.ok).toBe(true);
      if (again.ok) {
        expect(again.reused).toBe('open');
        expect(again.id).toBe(id);
      }
      expect(sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).toArray()[0]!.status).toBe('open');
    });
  });

  it('a stale sending claim is owner-visible and reconciliable without a duplicate send', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-stale-sending'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sql, sentRaw, tick } = await setup(state, {});
      // simulate a crashed send: claimed with a stamped claim time, no provider call happened
      sql.exec("UPDATE ledger SET status = 'sending', decided_at = ? WHERE id = ?", 1_000_000, id);
      tick(6 * 60_000); // past the 5-minute claim lease
      expect(desk.pending(1_000_000 + 6 * 60_000).some((item) => item.id === id && item.state === 'unknown')).toBe(true);
      const recheck = await desk.decide(id, 'r', 't');
      expect(recheck.toast).toBe('Not in Sent yet');
      expect(recheck.buttons).toEqual([['Check Sent', `r:${id}`], ['I checked Sent - not there', `x:${id}`]]);
      expect(sentRaw).toHaveLength(0); // reconciliation NEVER issues a provider send
      expect((await desk.decide(id, 'x', 't')).toast).toBe('Marked as not sent');
      expect(sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).toArray()[0]!.status).toBe('failed');
    });
  });

  it('a fresh sending claim (inside the lease) rejects r/x - a live send is not reconciled away', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-fresh-sending'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, tick } = await setup(state, {});
      state.storage.sql.exec("UPDATE ledger SET status = 'sending', decided_at = ? WHERE id = ?", 1_000_000, id);
      tick(60_000); // well inside the lease
      expect(desk.pending(1_000_000 + 60_000).some((item) => item.id === id)).toBe(false);
      expect((await desk.decide(id, 'r', 't')).toast).toBe('Already handled.');
      expect((await desk.decide(id, 'x', 't')).toast).toBe('Already handled.');
    });
  });

  it('ledger() never carries email body or Bcc into unrelated model context', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-ledger-privacy'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id } = await setup(state, {});
      const text = desk.ledger([]);
      expect(text).toContain('an email send approval (waiting on you)');
      expect(text).not.toContain('Hello'); // subject
      expect(text).not.toContain(proposal.body);
      expect(text).not.toContain('a@x.test'); // recipient
      await desk.decide(id, 's', 't');
      const after = desk.ledger([]);
      expect(after).not.toContain(proposal.body);
      expect(after).not.toContain('a@x.test');
    });
  });

  it('pins the sending connection and reconciles that SAME account', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-pin'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, googlePins, sql } = await setup(state, { sendError: new Error('network timeout'), found: false });
      expect((await desk.decide(id, 'a', 't')).toast).toBe('Send unconfirmed');
      // the connection that performed the send is pinned on the ledger row before I/O resolves
      expect(sql.exec<{ connection: string | null }>('SELECT connection FROM ledger WHERE id = ?', id).toArray()[0]!.connection).toBe('conn-test');
      // reconciliation goes back to that SAME pinned connection, never a fresh account pick
      await desk.decide(id, 'r', 't');
      expect(googlePins[googlePins.length - 1]).toBe('conn-test');
    });
  });

  it('an unavailable pinned connection stays unknown with reconnect/review guidance and never leaks the id', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-pin-gone'));
    await runInDurableObject(stub, async (_i, state) => {
      const { desk, id, sql } = await setup(state, { sendError: new Error('network timeout'), found: false, pinUnavailable: true });
      expect((await desk.decide(id, 'a', 't')).toast).toBe('Send unconfirmed');
      const out = await desk.decide(id, 'r', 't');
      expect(out.toast).toBe('Account unavailable');
      expect(out.message).toContain('Reconnect');
      expect(out.message).toContain('check Sent yourself');
      expect(out.message).not.toContain('conn-test');
      expect(out.buttons).toEqual([['Check Sent', `r:${id}`], ['I checked Sent - not there', `x:${id}`]]);
      expect(sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).toArray()[0]!.status).toBe('unknown');
    });
  });

  it('repeated reconciliation proves delivery: a later positive Sent hit closes the row done', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-reconcile-late'));
    await runInDurableObject(stub, async (_i, state) => {
      let found = false;
      const client = {
        sendRaw: async () => { throw new Error('network timeout'); },
        findSentByMessageId: async () => found,
      } as unknown as GoogleClient;
      const desk = approvalDesk(state.storage.sql, {
        call: async () => ({}), owner: 42, google: async () => ({ client, connection: 'conn-test' }),
        newId: () => 'rc1', now: () => 1_000_000, timezone: 'Asia/Kolkata', log: () => undefined,
      });
      const { sha256Hex } = await import('../src/connectors/google');
      const proposed = await desk.proposeSendEmail({ ...proposal, digest: await sha256Hex(proposal.raw) });
      if (!proposed.ok) throw new Error('unexpected proposal failure');
      expect((await desk.decide(proposed.id, 'a', 't')).toast).toBe('Send unconfirmed');
      expect((await desk.decide(proposed.id, 'r', 't')).toast).toBe('Not in Sent yet');
      found = true; // Gmail's index catches up
      const resolved = await desk.decide(proposed.id, 'r', 't');
      expect(resolved.toast).toBe('Found in Sent');
      expect(resolved.message).toContain('in your Sent folder');
      expect(resolved.message).not.toContain('exactly once');
      expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', proposed.id).toArray()[0]!.status).toBe('done');
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
