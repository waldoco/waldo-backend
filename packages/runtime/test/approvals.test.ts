import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk, PROPOSAL_TTL_MS, UNDO_WINDOW_MS } from '../src/channels/approvals';
import { GoogleError, type GoogleClient } from '../src/connectors/google';

const iso = (s: string) => s as never;

describe('approval desk', () => {
  it('promotes only host-checked receipts and passes the fresh desk approval reference', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-browser-checked-receipt'));
    await runInDurableObject(stub, async (_instance, state) => {
      let next = 0;
      for (const checked of [true, false, 'throws'] as const) {
        let seen = '';
        const desk = approvalDesk(state.storage.sql, { owner: 42, call: async () => ({}), google: async () => null, newId: () => `checked-${++next}`, now: () => 1000, timezone: 'UTC', log: () => {},
          browserSubmit: async (_payload, approval) => { seen = approval!; return { status: 'verified_with_receipt', message: 'Verified fixture', receipt: {} } as never; },
          browserReceiptVerified: async () => { if (checked === 'throws') throw Error('unavailable'); return checked; },
        });
        const id = await desk.proposeBrowserSubmit({ url: 'https://fixture.invalid', action: { selector: '#submit', description: 'Submit' }, binding: { value: 'synthetic' }, steps: [] });
        expect((await desk.decide(id, 'a', 'test')).toast).toBe(checked === true ? 'Verified' : 'Receipt not checked');
        expect(seen).toBe(id);
        expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe(checked === true ? 'done' : 'unverified');
        expect((await desk.decide(id, 'a', 'test')).toast).toBe('Already handled.');
      }
    });
  });
  it('browser outcomes never claim Done without checked durable receipt, and consume replay/concurrent callbacks', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-browser-outcomes'));
    await runInDurableObject(stub, async (_instance, state) => {
      let n = 0; let calls = 0;
      const messages: string[] = [];
      const logs: import('../src/channels/telegram-listener').TurnLogEntry[] = [];
      const payload = { url: 'https://fixture.invalid', action: { selector: '#submit', description: 'Submit' }, binding: { total: '1' }, steps: [] };
      const base = { call: async (_method: string, body: object) => { messages.push(JSON.stringify(body)); return {}; }, owner: 42,
        google: async () => null, newId: () => String(++n), now: () => 1000, timezone: 'UTC', log: (entry: import('../src/channels/telegram-listener').TurnLogEntry) => logs.push(entry) };
      for (const [status, expected, toast] of [ ['rejected', 'rejected', 'Not done'], ['acknowledged_unverified', 'unverified', 'Result not verified'],
        ['uncertain', 'uncertain', 'Outcome unknown'], ['verified_with_receipt', 'unverified', 'Receipt not checked'], ['bogus', 'uncertain', 'Outcome unknown'] ] as const) {
        const desk = approvalDesk(state.storage.sql, { ...base, browserSubmit: async () => { calls++; return { status, message: 'fixture result', receipt: { id: 'fake', observed_at: 'old', action_digest: 'wrong', binding_digest: 'wrong' } } as never; } });
        const id = await desk.proposeBrowserSubmit(payload);
        expect((await desk.decide(id, 'a', 'test')).toast).toBe(toast);
        expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe(expected);
        const before = calls;
        // New desk simulates reconstructed approval state after eviction.
        const restarted = approvalDesk(state.storage.sql, { ...base, browserSubmit: async () => { calls++; throw new Error('must not replay'); } });
        expect((await restarted.decide(id, 'a', 'test')).toast).toBe('Already handled.');
        expect(calls).toBe(before);
      }
      for (const malformed of [null, undefined, 'old string result', { status: 'acknowledged_unverified' }, { status: 'rejected', message: '' }]) {
        const desk = approvalDesk(state.storage.sql, { ...base, browserSubmit: async () => malformed as never });
        const id = await desk.proposeBrowserSubmit(payload);
        expect((await desk.decide(id, 'a', 'test')).toast).toBe('Outcome unknown');
        expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('uncertain');
        expect(desk.pending(1000).some((item) => item.id === id)).toBe(false);
        expect(desk.ledger([])).toContain('uncertain:');
      }
      const throwing = approvalDesk(state.storage.sql, { ...base, browserSubmit: async () => { throw new Error('response lost'); } });
      const thrown = await throwing.proposeBrowserSubmit(payload);
      expect((await throwing.decide(thrown, 'a', 'test')).toast).toBe('Outcome unknown');
      const missing = approvalDesk(state.storage.sql, base);
      const absent = await missing.proposeBrowserSubmit(payload);
      expect((await missing.decide(absent, 'a', 'test')).toast).toBe('Browsing is not set up');
      expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', absent).one().status).toBe('rejected');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const concurrent = approvalDesk(state.storage.sql, { ...base, browserSubmit: async () => { calls++; await gate; return { status: 'uncertain', message: 'unknown' }; } });
      const id = await concurrent.proposeBrowserSubmit(payload);
      const first = concurrent.decide(id, 'a', 'test');
      expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('uncertain');
      // A crash at this point leaves terminal uncertain, not an open action.
      const before = calls;
      expect((await concurrent.decide(id, 'a', 'test')).toast).toBe('Already handled.');
      expect(calls).toBe(before); release(); await first;
      expect(messages.some((message) => message.includes('"text":"Done"'))).toBe(false);
      expect(logs.some((entry) => entry.hop === 'browser_outcome' && entry.code === 'uncertain')).toBe(true);
      expect(concurrent.ledger([])).toContain('uncertain');
    });
  });

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
        browserSubmit: async (p) => { executed.push(p.action.description); return { status: 'acknowledged_unverified' as const, message: 'Action acknowledged, result not verified.' }; },
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
      expect(sent.filter((item) => item.method === 'answerCallbackQuery').map((item) => item.body.text)).toEqual(['Result not verified', 'Already handled.']);
      expect(executed).toEqual(['Place the order']);

      // never undoable
      const undone = await desk.decide(id, 'u', 't');
      expect(undone.toast).toBe("Already handled.");

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

  it('message_send: proposes with Send it / Modify / Not now, executes verbatim ONLY on approve, collapses a repeated idempotency key', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-message'));
    await runInDurableObject(stub, async (_instance, state) => {
      const sent: { method: string; body: Record<string, unknown> }[] = [];
      const delivered: string[] = [];
      let now = 1_000_000;
      let n = 0;
      const desk = approvalDesk(state.storage.sql, {
        call: async (method, body) => { sent.push({ method, body: body as Record<string, unknown> }); return {}; },
        owner: 42, google: async () => null, newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
        sendMessage: async (p) => { delivered.push(`${p.channel}:${p.content}`); },
      });
      const id = await desk.proposeSendMessage({ channel: 'telegram', content: 'Running 10 late', idempotency_key: 'k'.repeat(64) });
      expect(sent[0]!.body.text).toBe('Send this message on telegram?\n\nRunning 10 late');
      const keyboard = JSON.stringify(sent[0]!.body.reply_markup);
      expect(keyboard).toContain(`a:${id}`);
      expect(keyboard).toContain(`e:${id}`);
      expect(keyboard).toContain(`s:${id}`);
      expect(delivered).toEqual([]);

      await desk.callback({ id: 'q1', from: { id: 42 }, data: `a:${id}` }, 't');
      expect(delivered).toEqual(['telegram:Running 10 late']);

      // never undoable
      const undone = await desk.decide(id, 'u', 't');
      expect(undone.toast).toBe("Can't be undone");

      // ADR-0054: a second proposal with the same key approves onto the first send
      const id2 = await desk.proposeSendMessage({ channel: 'telegram', content: 'Running 10 late', idempotency_key: 'k'.repeat(64) });
      const again = await desk.decide(id2, 'a', 't');
      expect(again.toast).toBe('Already sent');
      expect(delivered).toHaveLength(1);

      // a different key sends independently
      const id3 = await desk.proposeSendMessage({ channel: 'telegram', content: 'Running 10 late', idempotency_key: 'z'.repeat(64) });
      const fresh = await desk.decide(id3, 'a', 't');
      expect(fresh.toast).toBe('Sent');
      expect(delivered).toHaveLength(2);

      // 12-hour TTL applies
      const id4 = await desk.proposeSendMessage({ channel: 'telegram', content: 'hi', idempotency_key: 'y'.repeat(64) });
      now += PROPOSAL_TTL_MS + 1;
      const late = await desk.decide(id4, 'a', 't');
      expect(late.toast).toBe('This proposal expired');

      // no executor configured -> honest refusal
      const desk2 = approvalDesk(state.storage.sql, {
        call: async (method, body) => { sent.push({ method, body: body as Record<string, unknown> }); return {}; },
        owner: 42, google: async () => null, newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
      });
      const id5 = await desk2.proposeSendMessage({ channel: 'telegram', content: 'hi', idempotency_key: 'x'.repeat(64) });
      const noExec = await desk2.decide(id5, 'a', 't');
      expect(noExec.toast).toBe('Messaging is not set up');
    });
  });

  it('mcp_call: proposes with Do it / Not now, executes ONLY on approve and reports a bounded outcome, never undoes', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-mcp'));
    await runInDurableObject(stub, async (_instance, state) => {
      const sent: { method: string; body: Record<string, unknown> }[] = [];
      const executed: string[] = [];
      let now = 1_000_000;
      let n = 0;
      const desk = approvalDesk(state.storage.sql, {
        call: async (method, body) => { sent.push({ method, body: body as Record<string, unknown> }); return {}; },
        owner: 42, google: async () => null, newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
        mcpCall: async (p) => { executed.push(`${p.server}.${p.tool}`); return 'Result (external content, bounded): {"ok":true} (protocol 2025-06-18)'; },
      });
      const id = await desk.proposeMcpCall({ server: 'github', tool: 'merge_pr', args: { n: 1 } });
      expect(sent[0]!.body.text).toBe('Run this MCP tool? Run merge_pr on the github MCP server\n\nArgs:\n{\n  "n": 1\n}');
      const keyboard = JSON.stringify(sent[0]!.body.reply_markup);
      expect(keyboard).toContain(`a:${id}`);
      expect(keyboard).toContain(`s:${id}`);
      expect(keyboard).not.toContain(`e:${id}`);
      expect(executed).toEqual([]);

      const out = await desk.decide(id, 'a', 't');
      expect(out.toast).toBe('Done');
      expect(out.message).toContain('Result (external content, bounded)');
      expect(executed).toEqual(['github.merge_pr']);

      // never undoable
      const undone = await desk.decide(id, 'u', 't');
      expect(undone.toast).toBe("Can't be undone");

      // no executor configured -> honest refusal
      const desk2 = approvalDesk(state.storage.sql, {
        call: async (method, body) => { sent.push({ method, body: body as Record<string, unknown> }); return {}; },
        owner: 42, google: async () => null, newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
      });
      const id2 = await desk2.proposeMcpCall({ server: 'github', tool: 'merge_pr', args: {} });
      const noExec = await desk2.decide(id2, 'a', 't');
      expect(noExec.toast).toBe('MCP is not set up');
      expect(executed).toHaveLength(1);
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
        event: async (id: string) => ({ id, title: 'Gym', start: '2026-09-23T18:00:00+05:30', end: '2026-09-23T19:00:00+05:30', all_day: false, etag: 'v1' }),
        moveEvent: async (id: string, start: string) => { google.push(`move ${id} ${start}`); return { id, title: 'Gym', start, end: start, all_day: false, etag: 'v1' }; },
        createEvent: async () => { google.push('create'); return { id: 'new1', title: 'x', start: '', end: '', all_day: false, etag: 'v1' }; },
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
          return { id, title: 'Gym', start, end: start, all_day: false, etag: 'v1' };
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
        event: async (id: string) => ({ id, title: 'Gym', start: '2026-09-23T18:00:00+05:30', end: '2026-09-23T19:00:00+05:30', all_day: false, etag: 'v1' }),
        moveEvent: async (id: string, start: string) => { google.push(`move ${id} ${start}`); return { id, title: 'Gym', start, end: start, all_day: false, etag: 'v1' }; },
        createEvent: async () => { google.push('create'); return { id: 'new1', title: 'x', start: '', end: '', all_day: false, etag: 'v1' }; },
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
      expect(listed[0]).toMatchObject({ id, kind: 'calendar_change', state: 'open', undoable: false });
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

describe('calendar Undo version protection', () => {
  const setup = async (state: DurableObjectState, action: 'create' | 'move') => {
    let current: { id: string; title: string; start: string; end: string; all_day: boolean; etag?: string } | null = {
      id: 'e1', title: 'Gym', start: '2026-10-07T10:00:00Z', end: '2026-10-07T11:00:00Z', all_day: false, etag: 'v1',
    };
    const original = { ...current };
    const writes: { op: string; match?: string }[] = [];
    let race = false;
    let failure = false;
    let missingApplied = false;
    let readFailure = false;
    const check = (match?: string) => {
      if (race) { current = { ...current!, title: 'Later owner edit', start: '2026-10-07T15:00:00Z', end: '2026-10-07T16:00:00Z', etag: 'v3' }; race = false; }
      if (failure) throw new GoogleError(503, 'provider unavailable');
      if (match && match !== current?.etag) throw new GoogleError(412, 'precondition failed');
    };
    const client = {
      event: async () => { if (readFailure) throw new GoogleError(503, 'read unavailable'); return { ...current! }; },
      createEvent: async (input: { title: string; start: string; end: string }) => {
        current = { ...current!, ...input, etag: 'v2' };
        writes.push({ op: 'create' });
        return { ...current, etag: missingApplied ? undefined : current.etag };
      },
      moveEvent: async (_id: string, start: string, end: string, match?: string) => {
        writes.push({ op: 'move', match }); check(match);
        current = { ...current!, start, end, etag: current!.etag === 'v1' ? 'v2' : 'v4' };
        return { ...current, etag: missingApplied ? undefined : current.etag };
      },
      cancelEvent: async (_id: string, match?: string) => { writes.push({ op: 'cancel', match }); check(match); current = null; },
    } as unknown as GoogleClient;
    const deps = { owner: 42, call: async () => ({}), google: async () => client, newId: () => 'version', now: () => 1000, timezone: 'UTC', log: () => {} };
    const desk = approvalDesk(state.storage.sql, deps);
    const id = await desk.propose({ action, ...(action === 'move' ? { event_id: 'e1' } : {}), title: 'Gym', start: iso('2026-10-07T12:00:00Z'), end: iso('2026-10-07T13:00:00Z'), reason: 'Owner request' });
    return { desk, id, original, writes, current: () => current, edit: () => { current = { ...current!, title: 'Later owner edit', start: '2026-10-07T15:00:00Z', end: '2026-10-07T16:00:00Z', etag: 'v3' }; }, race: () => { race = true; }, fail: (value: boolean) => { failure = value; }, missingApplied: () => { missingApplied = true; }, missingCurrent: () => { current = { ...current!, etag: undefined }; }, failRead: () => { readFailure = true; }, reopen: () => approvalDesk(state.storage.sql, deps) };
  };

  it.each(['create', 'move'] as const)('preserves later owner edits after approved %s', async (action) => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`undo-edited-${action}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const f = await setup(state, action);
      expect((await f.desk.decide(f.id, 'a', 't')).toast).toBe('Done');
      f.edit();
      const out = await f.reopen().decide(f.id, 'u', 't');
      expect(f.current()).toMatchObject({ title: 'Later owner edit', start: '2026-10-07T15:00:00Z', end: '2026-10-07T16:00:00Z', etag: 'v3' });
      expect(f.writes).toHaveLength(1);
      expect(out.toast).toBe('The event changed');
      expect(out.message).toContain("didn't undo");
      expect(f.desk.ledger([])).not.toContain('- undone:');
    });
  });
  it.each(['create', 'move'] as const)('undoes unchanged %s once using the persisted applied version', async (action) => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`undo-unchanged-${action}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const f = await setup(state, action);
      await f.desk.decide(f.id, 'a', 't');
      const saved = state.storage.sql.exec<{ undo_json: string }>('SELECT undo_json FROM ledger WHERE id = ?', f.id).one();
      expect(JSON.parse(saved.undo_json)).toMatchObject({ applied_etag: 'v2' });
      const reopened = f.reopen();
      await reopened.callback({ id: 'undo-1', from: { id: 42 }, data: `u:${f.id}` }, 't');
      expect(f.writes.at(-1)).toEqual({ op: action === 'create' ? 'cancel' : 'move', match: 'v2' });
      expect(f.current()).toEqual(action === 'create' ? null : { ...f.original, etag: 'v4' });
      await reopened.callback({ id: 'undo-2', from: { id: 42 }, data: `u:${f.id}` }, 't');
      expect((await reopened.decide(f.id, 'u', 't')).toast).toBe('Already handled.');
      expect(f.writes).toHaveLength(2);
      expect(reopened.ledger([])).toContain('- undone:');
    });
  });

  it.each(['create', 'move'] as const)('preserves a %s edit between fresh read and conditional Undo write', async (action) => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`undo-raced-${action}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const f = await setup(state, action);
      await f.desk.decide(f.id, 'a', 't');
      f.race();
      const out = await f.desk.decide(f.id, 'u', 't');
      expect(out.toast).toBe('The event changed');
      expect(f.writes.at(-1)?.match).toBe('v2');
      expect(f.current()).toMatchObject({ title: 'Later owner edit', start: '2026-10-07T15:00:00Z', end: '2026-10-07T16:00:00Z', etag: 'v3', start: '2026-10-07T15:00:00Z' });
      expect(f.desk.ledger([])).not.toContain('- undone:');
      await f.desk.decide(f.id, 'u', 't');
      expect(f.writes).toHaveLength(2);
    });
  });

  it.each(['create', 'move'] as const)('does not offer unsafe Undo when %s returns no applied etag', async (action) => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`undo-versionless-${action}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const f = await setup(state, action);
      f.missingApplied();
      const approved = await f.desk.decide(f.id, 'a', 't');
      expect(approved.toast).toBe('Done');
      expect(approved.message).not.toContain('Undo is available');
      expect(f.desk.pending(1000).some((item) => item.id === f.id && item.undoable)).toBe(false);
      expect((await f.desk.decide(f.id, 'u', 't')).toast).toBe("Can't be undone");
      expect(f.writes).toHaveLength(1);
    });
  });

  it.each(['create', 'move'] as const)('refuses legacy and missing current versions for %s without writing', async (action) => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`undo-legacy-${action}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const f = await setup(state, action);
      await f.desk.decide(f.id, 'a', 't');
      const saved = state.storage.sql.exec<{ undo_json: string }>('SELECT undo_json FROM ledger WHERE id = ?', f.id).one();
      const legacy = JSON.parse(saved.undo_json) as Record<string, unknown>;
      delete legacy.applied_etag;
      state.storage.sql.exec('UPDATE ledger SET undo_json = ? WHERE id = ?', JSON.stringify(legacy), f.id);
      const legacyOut = await f.reopen().decide(f.id, 'u', 't');
      expect(legacyOut.toast).toBe("Can't be undone");
      expect(legacyOut.message).toContain('version is unavailable');
      state.storage.sql.exec('UPDATE ledger SET undo_json = ? WHERE id = ?', saved.undo_json, f.id);
      f.missingCurrent();
      expect((await f.desk.decide(f.id, 'u', 't')).toast).toBe('The event changed');
      expect(f.writes).toHaveLength(1);
      expect(f.desk.ledger([])).not.toContain('- undone:');
    });
  });

  it.each(['create', 'move'] as const)('keeps %s Undo failures honest and never retries with a newer version', async (action) => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`undo-failure-${action}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const f = await setup(state, action);
      await f.desk.decide(f.id, 'a', 't');
      f.fail(true);
      const failed = await f.desk.decide(f.id, 'u', 't');
      expect(failed.toast).toBe('That failed');
      expect(failed.message).not.toContain('Undone');
      expect(f.current()?.etag).toBe('v2');
      expect(f.desk.ledger([])).not.toContain('- undone:');
      f.fail(false); f.edit();
      expect((await f.desk.decide(f.id, 'u', 't')).toast).toBe('The event changed');
      expect(f.writes).toHaveLength(2);
      f.failRead();
      expect((await f.desk.decide(f.id, 'u', 't')).toast).toBe('That failed');
      expect(f.writes).toHaveLength(2);
    });
  });

  it.each(['create', 'move'] as const)('concurrent %s Undo attempts preserve the confirmed undone ledger', async (action) => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`undo-concurrent-${action}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const f = await setup(state, action);
      await f.desk.decide(f.id, 'a', 't');
      const results = await Promise.all([f.desk.decide(f.id, 'u', 't1'), f.desk.decide(f.id, 'u', 't2')]);
      expect(results.filter((result) => result.toast === 'Undone')).toHaveLength(1);
      expect(f.current()).toEqual(action === 'create' ? null : { ...f.original, etag: 'v4' });
      expect(f.desk.ledger([])).toContain('- undone:');
      expect((await f.desk.decide(f.id, 'u', 't3')).toast).toBe('Already handled.');
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
  const setup = async (state: DurableObjectState, opts: { sendError?: Error; found?: boolean; connected?: boolean; messageId?: string }) => {
    const sent: { method: string; body: Record<string, unknown> }[] = [];
    const sentRaw: string[] = [];
    let now = 1_000_000;
    let n = 0;
    const client = {
      sendRaw: async (raw: string) => { sentRaw.push(raw); if (opts.sendError) throw opts.sendError; return { message_id: 'g1' }; },
      findSentByMessageId: async () => opts.found ?? false,
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, {
      call: async (method, body) => { sent.push({ method, body: body as Record<string, unknown> }); return {}; },
      owner: 42, google: async () => (opts.connected === false ? null : client), newId: () => String(++idSeq), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined,
    });
    const { sha256Hex } = await import('../src/connectors/google');
    const id = await desk.proposeSendEmail({ ...proposal, message_id: opts.messageId ?? proposal.message_id, digest: await sha256Hex(proposal.raw) });
    return { desk, id, sent, sentRaw, sql: state.storage.sql, tick: (ms: number) => { now += ms; } };
  };

  it('the card is the full review: cc/bcc and the complete body are shown verbatim', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-review'));
    await runInDurableObject(stub, async (_i, state) => {
      const sent: { method: string; body: Record<string, unknown> }[] = [];
      const desk = approvalDesk(state.storage.sql, {
        call: async (method, body) => { sent.push({ method, body: body as Record<string, unknown> }); return {}; },
        owner: 42, google: async () => null, newId: () => '7', now: () => 1_000_000, timezone: 'Asia/Kolkata', log: () => undefined,
      });
      await desk.proposeSendEmail({
        to: ['a@x.test'], cc: ['c@x.test'], bcc: ['b@x.test'], subject: 'Quarterly', body: 'Line one\nLine two', message_id: '<m2@waldo-send>', raw: 'raw', digest: 'd',
      });
      expect(sent[0]!.body.text).toBe('Send this email? To: a@x.test\nCc: c@x.test\nBcc: b@x.test\nSubject: Quarterly\n\nLine one\nLine two');
    });
  });

  it('over-budget content is not approvable from the card: no Send it button, explicit notice', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-long'));
    await runInDurableObject(stub, async (_i, state) => {
      const sent: { method: string; body: Record<string, unknown> }[] = [];
      const desk = approvalDesk(state.storage.sql, {
        call: async (method, body) => { sent.push({ method, body: body as Record<string, unknown> }); return {}; },
        owner: 42, google: async () => null, newId: () => '8', now: () => 1_000_000, timezone: 'Asia/Kolkata', log: () => undefined,
      });
      await desk.proposeSendEmail({
        to: ['a@x.test'], subject: 'Long', body: 'x'.repeat(4000), message_id: '<m3@waldo-send>', raw: 'raw', digest: 'd',
      });
      const text = String(sent[0]!.body.text);
      expect(text).toContain("can't be approved here");
      const keyboard = JSON.stringify(sent[0]!.body.reply_markup);
      expect(keyboard).not.toContain('a:p8');
      expect(keyboard).toContain('s:p8');
      expect(desk.pending(1_000_000).find((item) => item.id === 'p8')?.state).toBe('review_only');
      expect((await desk.decide('p8', 'a', 't')).toast).toBe('Already handled.');
      expect((await desk.decide('p8', 's', 't')).toast).toBe('Not now');
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

      const id2 = await desk.proposeSendEmail({ ...proposal, message_id: '<m2@waldo-send>', digest: await (await import('../src/connectors/google')).sha256Hex(proposal.raw) });
      tick(13 * 60 * 60_000);
      const late = await desk.decide(id2, 'a', 't');
      expect(late.toast).toBe('This proposal expired');
      expect(sentRaw).toHaveLength(1);
    });
  });

  it('adds a deterministic receipt and only a view-details link, never a second send button', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-receipt'));
    await runInDurableObject(stub, async (_i, state) => {
      const sent: { method: string; body: Record<string, unknown> }[] = [];
      const desk = approvalDesk(state.storage.sql, {
        call: async (method, body) => { sent.push({ method, body: body as Record<string, unknown> }); return {}; },
        owner: 42, google: async () => null, newId: () => '41', now: () => 1_000_000,
        timezone: 'Asia/Kolkata', log: () => undefined, reviewUrl: async () => 'https://waldo.example/console/waiting',
      });
      const payload = { ...proposal, digest: await (await import('../src/connectors/google')).sha256Hex(proposal.raw) };
      const id = await desk.proposeSendEmail(payload);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.body.text).toContain('use the Send it instruction on that card');
      expect(sent[1]!.body.text).not.toContain('Tap Send it');
      expect(sent[1]!.body.text).toContain('https://waldo.example/console/waiting');
      expect(sent[1]!.body.text).toContain('Nothing has been sent');
      expect(sent[1]!.body.reply_markup).toBeUndefined();
      expect(await desk.proposeSendEmail(payload)).toBe(id);
      expect(sent).toHaveLength(2);
      await expect(desk.proposeSendEmail({ ...payload, subject: 'Changed' })).rejects.toThrow('identifier_reused');
    });
  });

  it('dedupes a retried owner turn despite fresh MIME Message-ID bytes, but not a later turn', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-turn-retry'));
    await runInDurableObject(stub, async (_i, state) => {
      let cards = 0;
      let next = 0;
      const desk = approvalDesk(state.storage.sql, {
        call: async () => { cards++; return {}; }, owner: 42, google: async () => null,
        newId: () => String(++next), now: () => 1_000_000, timezone: 'Asia/Kolkata', log: () => undefined,
      });
      const first = { ...proposal, dedupe_key: 'turn-1', digest: await (await import('../src/connectors/google')).sha256Hex(proposal.raw) };
      const id = await desk.proposeSendEmail(first);
      const retry = { ...first, message_id: '<fresh@waldo-send>', raw: 'fresh raw', digest: 'fresh digest' };
      expect(await desk.proposeSendEmail(retry)).toBe(id);
      expect(cards).toBe(2); // one card, one receipt
      expect(desk.pending(1_000_000).find((item) => item.id === id)?.state).toBe('open');
      await expect(desk.proposeSendEmail({ ...retry, subject: 'Changed' })).rejects.toThrow('identifier_reused');
      const later = await desk.proposeSendEmail({ ...retry, dedupe_key: 'turn-2' });
      expect(later).not.toBe(id);
      expect(cards).toBe(4);
    });
  });

  it('strands an uncertain card safely and exposes it as unconfirmed, not approvable', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-uncertain'));
    await runInDurableObject(stub, async (_i, state) => {
      const delivered: string[] = [];
      let first = true;
      const desk = approvalDesk(state.storage.sql, {
        call: async (method, body) => { if (first && method === 'sendMessage') { first = false; throw new Error('timeout'); } delivered.push(JSON.stringify(body)); return {}; }, owner: 42, google: async () => null,
        newId: () => '42', now: () => 1_000_000, timezone: 'Asia/Kolkata', log: () => undefined,
      });
      const payload = { ...proposal, digest: await (await import('../src/connectors/google')).sha256Hex(proposal.raw) };
      await expect(desk.proposeSendEmail(payload)).rejects.toThrow('card_unconfirmed');
      const item = desk.pending(1_000_000).find((candidate) => candidate.id === 'p42');
      expect(item?.state).toBe('unconfirmed');
      expect((await desk.decide('p42', 'a', 't')).toast).toBe('Already handled.');
      await expect(desk.proposeSendEmail(payload)).rejects.toThrow('card_unconfirmed');
      await desk.callback({ id: 'c42', from: { id: 42 }, data: 'a:p42' }, 'test');
      expect(delivered.join(' ')).toContain('Review not confirmed');
      expect(delivered.join(' ')).toContain('No email was sent');
    });
  });

  it('does not re-propose on secondary receipt failure after the review card arrives', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-email-receipt-failure'));
    await runInDurableObject(stub, async (_i, state) => {
      let calls = 0;
      const desk = approvalDesk(state.storage.sql, {
        call: async () => { if (++calls === 2) throw new Error('receipt timeout'); return {}; },
        owner: 42, google: async () => null, newId: () => '43', now: () => 1_000_000,
        timezone: 'Asia/Kolkata', log: () => undefined,
      });
      const payload = { ...proposal, digest: await (await import('../src/connectors/google')).sha256Hex(proposal.raw) };
      const id = await desk.proposeSendEmail(payload);
      expect(desk.pending(1_000_000).find((candidate) => candidate.id === id)?.state).toBe('open');
      expect(await desk.proposeSendEmail(payload)).toBe(id);
      expect(calls).toBe(2);
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

      const miss = await setup(state, { sendError: new Error('network timeout'), found: false, messageId: '<m4@waldo-send>' });
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
});

it('approved email propagates ledger intent and pending proxy outcome remains uncertain, never false not-delivered',async()=>{
 const {ProxyIntentError}=await import('../src/connectors/proxy-intent');const {sha256Hex}=await import('../src/connectors/google');
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-proxy-${crypto.randomUUID()}`));
 await runInDurableObject(stub,async(_instance,state)=>{
  const contexts:unknown[]=[];let sends=0;const raw='fixture-mime';
  const client={sendRaw:async()=>{sends++;throw new ProxyIntentError('intent_pending');},findSentByMessageId:async()=>false} as unknown as GoogleClient;
  const desk=approvalDesk(state.storage.sql,{call:async()=>({message_id:1}),owner:42,google:async(intent,feature)=>{contexts.push({intent,feature});return client;},newId:()=>crypto.randomUUID(),now:()=>1000,timezone:'UTC',log:()=>{}});
  const id=await desk.proposeSendEmail({to:['fictional@test.invalid'],subject:'fixture',body:'fixture',raw,digest:await sha256Hex(raw),message_id:'fixture-id'});
  const result=await desk.decide(id,'a','fixture');expect(result.toast).toBe('Outcome unknown');expect(result.message).not.toContain('Nothing was delivered');expect(contexts).toEqual([{intent:{id:`approval:${id}:apply`},feature:'mail'}]);
  expect(state.storage.sql.exec<{status:string}>('SELECT status FROM ledger WHERE id=?',id).one().status).toBe('uncertain');await desk.decide(id,'a','fixture');expect(sends).toBe(1);
 });
});
