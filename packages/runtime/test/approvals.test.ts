import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk, PROPOSAL_TTL_MS, UNDO_WINDOW_MS } from '../src/channels/approvals';
import { GoogleError, type GoogleClient } from '../src/connectors/google';
import { ProxyIntentError } from '../src/connectors/proxy-intent';

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
    let pendingSecond: Promise<void> | null = null;
    const waitPending = async () => {
      if (pendingSecond && writes.length === 3) { await pendingSecond; throw new ProxyIntentError('intent_pending'); }
    };
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
        writes.push({ op: 'move', match }); await waitPending(); check(match);
        current = { ...current!, start, end, etag: current!.etag === 'v1' ? 'v2' : 'v4' };
        return { ...current, etag: missingApplied ? undefined : current.etag };
      },
      cancelEvent: async (_id: string, match?: string) => { writes.push({ op: 'cancel', match }); await waitPending(); check(match); current = null; },
    } as unknown as GoogleClient;
    const deps = { owner: 42, call: async () => ({}), google: async () => client, newId: () => 'version', now: () => 1000, timezone: 'UTC', log: () => {} };
    const desk = approvalDesk(state.storage.sql, deps);
    const id = await desk.propose({ action, ...(action === 'move' ? { event_id: 'e1' } : {}), title: 'Gym', start: iso('2026-10-07T12:00:00Z'), end: iso('2026-10-07T13:00:00Z'), reason: 'Owner request' });
    return { desk, id, original, writes, current: () => current, edit: () => { current = { ...current!, title: 'Later owner edit', start: '2026-10-07T15:00:00Z', end: '2026-10-07T16:00:00Z', etag: 'v3' }; }, race: () => { race = true; }, fail: (value: boolean) => { failure = value; }, missingApplied: () => { missingApplied = true; }, missingCurrent: () => { current = { ...current!, etag: undefined }; }, failRead: () => { readFailure = true; }, delaySecondUndo: () => { let release!: () => void; pendingSecond = new Promise<void>((resolve) => { release = resolve; }); return release; }, reopen: () => approvalDesk(state.storage.sql, deps) };
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
      expect(f.current()).toMatchObject({ title: 'Later owner edit', start: '2026-10-07T15:00:00Z', end: '2026-10-07T16:00:00Z', etag: 'v3' });
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

  it.each(['create', 'move'] as const)('retains confirmed %s Undo after a delayed duplicate proxy uncertainty', async (action) => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`undo-late-pending-${action}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const f = await setup(state, action);
      await f.desk.decide(f.id, 'a', 't');
      const release = f.delaySecondUndo();
      const first = f.desk.decide(f.id, 'u', 't1');
      const second = f.desk.decide(f.id, 'u', 't2');
      expect((await first).toast).toBe('Undone');
      release();
      await second;
      expect(f.desk.ledger([])).toContain('- undone:');
      expect((await f.desk.decide(f.id, 'u', 't3')).toast).toBe('Already handled.');
      expect(f.current()).toEqual(action === 'create' ? null : { ...f.original, etag: 'v4' });
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
      // Labelled Sent metadata double: a send acknowledgement alone is insufficient.
      findSentByMessageId: async (messageId: string) => (opts.found ?? !opts.sendError) ? {message_id:'g1',thread_id:'synthetic-thread',rfc822_message_id:messageId,label_ids:['SENT']} : false,
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
      expect(out2.toast).toBe('Outcome unknown');
      expect(out2.message).not.toContain('Nothing was delivered');
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

describe('task source card ledger write', () => {
  it.each([true, false])('an approval card is open only once Telegram acknowledged it: blocked=%s', async blocked => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-blocked-card-${blocked}`));
    await runInDurableObject(stub, async (_instance, state) => {
      let n = 0; let ran = 0;
      const desk = approvalDesk(state.storage.sql, { owner: 42, call: async () => (blocked ? undefined : { message_id: 1 }), google: async () => null, newId: () => `blocked-${++n}`, now: () => 1000, timezone: 'UTC', log: () => {},
        browserSubmit: async () => { ran++; return { status: 'rejected', message: 'fixture', receipt: {} } as never; } });
      const proposals = [
        () => desk.proposeBrowserSubmit({ url: 'https://fixture.invalid', action: { selector: '#submit', description: 'Submit' }, binding: { value: 'synthetic' }, steps: [] }),
        () => desk.proposeSendMessage({ channel: 'telegram', content: 'Synthetic note', idempotency_key: 'k1' }),
        () => desk.proposeMcpCall({ server: 'github', tool: 'merge_pr', args: { n: 1 } }),
        () => desk.propose({ action: 'create', title: 'Walk', start: iso('2026-09-24T07:00:00+05:30'), end: iso('2026-09-24T07:30:00+05:30'), reason: 'morning slot' }),
      ];
      for (const propose of proposals) {
        if (blocked) await expect(propose()).rejects.toThrow('Approval card not confirmed');
        else await propose();
      }
      const rows = state.storage.sql.exec<{ id: string; status: string }>("SELECT id, status FROM ledger WHERE kind IN ('browser_submit', 'message_send', 'mcp_call', 'calendar_change')").toArray();
      expect(rows).toHaveLength(4);
      expect(rows.every(row => row.status === (blocked ? 'card_unconfirmed' : 'open'))).toBe(true);
      if (blocked) {
        expect(desk.pending(1000)).toEqual([]);
        for (const row of rows) expect((await desk.decide(row.id, 'a', 'test')).toast).toBe('Already handled.');
        expect(ran).toBe(0);
        expect(desk.ledger([]).match(/review card delivery unconfirmed; cannot approve/g)).toHaveLength(4);
      }
    });
  });
  it('a tap on an unconfirmed non-email card says nothing was done, and does not mention email', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('approval-blocked-card-tap'));
    await runInDurableObject(stub, async (_instance, state) => {
      let n = 0; let blocked = true; const said: string[] = [];
      const desk = approvalDesk(state.storage.sql, { owner: 42, google: async () => null, newId: () => `tap-${++n}`, now: () => 1000, timezone: 'UTC', log: () => {},
        call: async (method: string, body: object) => { if (method === 'sendMessage') { said.push(String((body as { text?: string }).text)); return blocked ? undefined : { message_id: 1 }; } return {}; } });
      const id = await desk.proposeSendMessage({ channel: 'telegram', content: 'Synthetic note', idempotency_key: 'k2' }).catch(() => 'ptap-1');
      blocked = false; said.length = 0;
      await desk.callback({ id: 'cb1', from: { id: 42 }, data: `a:${id}` } as never, 'trace');
      expect(said.join(' ')).toContain('Nothing was done');
      expect(said.join(' ')).not.toMatch(/email/i);
    });
  });
});


describe('calendar proposal dedupe within a turn', () => {
  it('reuses identical pending cards, but not different payloads, turns or decided cards', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('calendar-turn-dedupe'));
    await runInDurableObject(stub, async (_instance, state) => {
      let next = 0; let sent = 0;
      const desk = approvalDesk(state.storage.sql, { owner: 42, call: async () => { sent++; return {}; }, google: async () => null,
        newId: () => String(++next), now: () => 1000, timezone: 'UTC', log: () => {} });
      const payload = { action: 'create' as const, title: 'Lunch', start: iso('2026-10-09T12:00:00Z'), end: iso('2026-10-09T13:00:00Z'), reason: 'Owner requested' };
      const first = await desk.propose(payload, 'turn-1');
      expect(await desk.propose({ reason: payload.reason, end: payload.end, start: payload.start, title: payload.title, action: payload.action }, 'turn-1')).toBe(first);
      expect(sent).toBe(1);
      expect(await desk.propose({ ...payload, title: 'Dinner' }, 'turn-1')).not.toBe(first);
      await desk.decide(first, 's', 'test');
      expect(await desk.propose(payload, 'turn-1')).not.toBe(first);
      const nextTurn = await desk.propose(payload, 'turn-2');
      expect(nextTurn).not.toBe(first);
      expect(await desk.propose(payload, 'turn-2')).toBe(nextTurn);
      expect(await desk.propose(payload)).not.toBe(nextTurn);
      expect(await desk.propose(payload)).not.toBe(nextTurn);
    });
  });
  it('collapses concurrent proposals and never reuses an unconfirmed card', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('calendar-turn-concurrent'));
    await runInDurableObject(stub, async (_instance, state) => {
      let next = 0; let sent = 0; let fail = false;
      const desk = approvalDesk(state.storage.sql, { owner: 42, call: async () => { sent++; return fail ? null : {}; }, google: async () => null,
        newId: () => String(++next), now: () => 1000, timezone: 'UTC', log: () => {} });
      const payload = { action: 'create' as const, title: 'Lunch', start: iso('2026-10-09T12:00:00Z'), end: iso('2026-10-09T13:00:00Z'), reason: 'Owner requested' };
      const ids = await Promise.all([desk.propose(payload, 'turn-1'), desk.propose(payload, 'turn-1')]);
      expect(ids[0]).toBe(ids[1]); expect(sent).toBe(1);
      fail = true;
      await expect(desk.propose(payload, 'turn-2')).rejects.toThrow('Approval card not confirmed');
      fail = false;
      await desk.propose(payload, 'turn-2');
      expect(sent).toBe(3);
    });
  });
});

describe('approval presentations', () => {
  const NOW = Date.UTC(2026, 9, 10, 9, 0, 0);
  type Shown = { surface: string; message_ref: string; approvable: number; retired_at: number | null };
  const shown = (sql: SqlStorage, id: string) => sql.exec<Shown>('SELECT surface, message_ref, approvable, retired_at FROM approval_presentations WHERE approval_id = ? ORDER BY surface', id).toArray();
  const status = (sql: SqlStorage, id: string) => sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  const unpresented = (sql: SqlStorage) => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ledger l WHERE l.status IN ('open', 'review_only') AND NOT EXISTS (SELECT 1 FROM approval_presentations p WHERE p.approval_id = l.id)").one().n;
  const message = { channel: 'telegram', content: 'Running ten minutes late.', idempotency_key: 'late-1' };

  it('opens a row only when a surface recorded the review; an unrepresentable app card, a failed commit or a blocked send leaves it unconfirmed', async () => {
    const { appCaller } = await import('../src/channels/surfaces/app');
    const { appApprovalParts } = await import('../src/channels/approvals');
    const { sha256Hex } = await import('../src/connectors/google');
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-presentations-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql; let n = 0; const appCalls: string[] = [];
      const base = { owner: 42, google: async () => null, newId: () => `pres${++n}`, now: () => NOW, timezone: 'UTC', log: () => {} };
      const app = { ...base, owner: 7_000_000_000_001, surface: 'app' as const, call: async (method: string, body: object) => { appCalls.push(method); return appCaller()(method, body); } };

      const unrepresentable = approvalDesk(sql, { ...app, now: () => 1_000_000 });
      await expect(unrepresentable.proposeSendMessage(message)).rejects.toThrow();
      expect(status(sql, 'ppres1')).toBe('card_unconfirmed'); expect(shown(sql, 'ppres1')).toEqual([]);

      const commitDown = approvalDesk(sql, { ...app, commit: () => { throw Error('storage down'); } });
      await expect(commitDown.proposeSendMessage({ ...message, idempotency_key: 'late-2' })).rejects.toThrow('storage down');
      expect(status(sql, 'ppres2')).toBe('card_unconfirmed'); expect(shown(sql, 'ppres2')).toEqual([]);

      const blocked = approvalDesk(sql, { ...base, call: async () => undefined });
      await expect(blocked.proposeSendMessage({ ...message, idempotency_key: 'late-3' })).rejects.toThrow('Approval card not confirmed');
      expect(status(sql, 'ppres3')).toBe('card_unconfirmed'); expect(shown(sql, 'ppres3')).toEqual([]);

      const mirrored = approvalDesk(sql, { ...base, call: async () => undefined, appIdentity: () => true });
      const opened = await mirrored.proposeSendMessage({ ...message, idempotency_key: 'late-4' });
      expect(status(sql, opened)).toBe('open');
      expect(shown(sql, opened)).toEqual([{ surface: 'app', message_ref: `approval:${opened}`, approvable: 1, retired_at: null }]);
      expect(mirrored.placement(opened)).toEqual({ here: false, hereApprovable: false, app: true, appApprovable: true });

      const email = approvalDesk(sql, { ...base, call: async (method: string) => method === 'sendMessage' ? { message_id: 501, chat: { id: 42 } } : true });
      const raw = 'To: a@x.test\r\nSubject: Hi\r\n\r\nHello';
      const sent = await email.proposeSendEmail({ to: ['a@x.test'], subject: 'Hi', body: 'Hello', message_id: '<pres@waldo-send>', raw, digest: await sha256Hex(raw) });
      expect(shown(sql, sent)).toEqual([{ surface: 'telegram', message_ref: '42:501', approvable: 1, retired_at: null }]);
      expect(email.placement(sent)).toEqual({ here: true, hereApprovable: true, app: false, appApprovable: false });

      const fromApp = approvalDesk(sql, { ...app, currentRunRef: () => 'app-message-0001' });
      const proposed = await fromApp.propose({ action: 'create', title: 'Walk', start: iso('2026-10-10T15:00:00Z'), end: iso('2026-10-10T15:30:00Z'), reason: 'afternoon slot' });
      expect(status(sql, proposed)).toBe('open');
      expect(appCalls).toEqual([]);
      expect(sql.exec<{ origin_run_ref: string }>('SELECT origin_run_ref FROM ledger WHERE id = ?', proposed).one().origin_run_ref).toBe('app-message-0001');
      expect(shown(sql, proposed)).toMatchObject([{ surface: 'app', message_ref: 'run:app-message-0001', approvable: 1 }]);
      const [part] = appApprovalParts(sql)('app-message-0001');
      const payload = sql.exec<{ payload_json: string }>('SELECT payload_json FROM ledger WHERE id = ?', proposed).one().payload_json;
      expect(part).toMatchObject({ type: 'approval', approval_id: proposed, kind: 'calendar_change', actions: ['approve', 'edit', 'skip'], payload_digest: `sha256:${await sha256Hex(payload)}`, expires_at: Date.parse('2026-10-10T15:00:00Z') });
      expect(part!.review).toContain('Add "Walk"');
      expect(appApprovalParts(sql)('another-run')).toEqual([]);
      expect(sql.exec<{ name: string }>('PRAGMA table_info(approval_presentations)').toArray().map(column => column.name)).toEqual(['approval_id', 'surface', 'message_ref', 'presented_at', 'approvable', 'payload_digest', 'retired_at']);
      expect(unpresented(sql)).toBe(0);
    });
  });

  it('a review too long for Telegram opens through the app, and an approve from Telegram is refused with the app link', async () => {
    const { appApprovalLink } = await import('../src/channels/surfaces/app');
    const { sha256Hex } = await import('../src/connectors/google');
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-presentations-long-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql; let n = 0; let sends = 0;
      const sent: { method: string; body: Record<string, unknown> }[] = [];
      const client = { sendRaw: async () => { sends++; return { message_id: 'g1' }; }, findSentByMessageId: async (id: string) => ({ message_id: 'g1', thread_id: 't', rfc822_message_id: id, label_ids: ['SENT'] }) } as unknown as GoogleClient;
      const desk = approvalDesk(sql, { owner: 42, google: async () => client, newId: () => `long${++n}`, now: () => NOW, timezone: 'UTC', log: () => {}, appIdentity: () => true, appLink: appApprovalLink,
        call: async (method, body) => { sent.push({ method, body: body as Record<string, unknown> }); return method === 'sendMessage' ? { message_id: sent.length, chat: { id: 42 } } : true; } });
      const raw = `To: a@x.test\r\nSubject: Long\r\n\r\n${'x'.repeat(5000)}`;
      const id = await desk.proposeSendEmail({ to: ['a@x.test'], subject: 'Long', body: 'x'.repeat(5000), message_id: '<long@waldo-send>', raw, digest: await sha256Hex(raw) });
      const card = sent[0]!;
      expect(String(card.body.text)).toContain("can't be approved here");
      expect(String(card.body.text)).toContain(`waldo://approvals/${id}`);
      expect(JSON.stringify(card.body.reply_markup)).not.toContain(`a:${id}`);
      expect(status(sql, id)).toBe('open');
      expect(shown(sql, id).map(row => [row.surface, row.approvable])).toEqual([['app', 1], ['telegram', 0]]);

      sent.length = 0;
      await desk.callback({ id: 'forged', from: { id: 42 }, data: `a:${id}`, message: { message_id: 1, chat: { id: 42 } } }, 'trace');
      expect(sent.find(call => call.method === 'answerCallbackQuery')?.body.text).toBe('Review it in the app');
      expect(String(sent.find(call => call.method === 'sendMessage')?.body.text)).toContain(`waldo://approvals/${id}`);
      expect((await desk.decide(id, 'a', 'trace')).toast).toBe('Review it in the app');
      expect((await desk.decide(id, 'e', 'trace', { surface: 'telegram' })).toast).toBe('Review it in the app');
      expect(sends).toBe(0); expect(status(sql, id)).toBe('open');
      expect((await desk.decide(id, 'a', 'trace', { surface: 'app' })).toast).toBe('Sent');
      expect(sends).toBe(1);

      sent.length = 0;
      const huge = `To: a@x.test\r\nSubject: Huge\r\n\r\n${'y'.repeat(33_000)}`;
      const tooLong = await desk.proposeSendEmail({ to: ['a@x.test'], subject: 'Huge', body: 'y'.repeat(33_000), message_id: '<huge@waldo-send>', raw: huge, digest: await sha256Hex(huge) });
      expect(String(sent[0]!.body.text)).not.toContain('waldo://');
      expect(status(sql, tooLong)).toBe('review_only');
      const [appView] = await desk.approvals(NOW, { id: tooLong });
      expect(appView).toMatchObject({ state: 'review_only', actions: ['skip'] });
      expect(appView!.review.length).toBeLessThan(1000);
      expect((await desk.decide(tooLong, 'a', 'trace', { surface: 'app' })).toast).toBe('Already handled.');
      expect(sends).toBe(1);
    });
  });

  it('an app approve is refused for a card only ever shown on Telegram', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-presentations-telegram-only-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const sent: string[] = [];
      const desk = approvalDesk(state.storage.sql, { owner: 42, google: async () => null, newId: () => 'tgonly', now: () => NOW, timezone: 'UTC', log: () => {},
        call: async (method: string) => method === 'sendMessage' ? { message_id: 3, chat: { id: 42 } } : true, sendMessage: async proposal => { sent.push(proposal.content); return { provider_id: 'tg-3' }; } });
      const id = await desk.proposeSendMessage(message);
      expect(shown(state.storage.sql, id).map(row => row.surface)).toEqual(['telegram']);
      expect((await desk.decide(id, 'a', 'trace', { surface: 'app' })).toast).toBe('Not available here');
      expect((await desk.decide(id, 'e', 'trace', { surface: 'app' })).toast).toBe('Not available here');
      expect(sent).toEqual([]); expect(status(state.storage.sql, id)).toBe('open');
      expect((await desk.decide(id, 'a', 'trace', { surface: 'telegram', messageRef: '42:3' })).toast).toBe('Sent');
      expect(sent).toEqual([message.content]);
    });
  });

  it('the app text sink never acknowledges a callback keyboard as shown', async () => {
    const { appCaller } = await import('../src/channels/surfaces/app');
    const call = appCaller();
    expect(await call('sendMessage', { chat_id: 7, text: 'Hello' })).toMatchObject({ message_id: 1 });
    expect(await call('sendMessage', { chat_id: 7, text: 'Connect', reply_markup: { inline_keyboard: [[{ text: 'Connect Google', url: 'https://example.test/c' }]] } })).toMatchObject({ message_id: 1 });
    expect(await call('sendMessage', { chat_id: 7, text: 'Proposed', reply_markup: { inline_keyboard: [[{ text: 'Do it', callback_data: 'a:p1' }]] } })).toBeUndefined();
    expect(await call('editMessageReplyMarkup', { chat_id: 7, message_id: 1 })).toBeUndefined();
  });
});

describe('app approval projection', () => {
  const NOW = Date.UTC(2026, 9, 10, 9, 0, 0);
  it('maps every desk status to one app state, shows the exact block per kind and the stored digest, and offers undo only with undo data', async () => {
    const { APP_APPROVAL_STATE } = await import('../src/channels/approvals');
    const { appApprovalStateV1Schema, appApprovalV1Schema } = await import('../../contracts/src/app/approvals');
    expect(Object.keys(APP_APPROVAL_STATE).sort()).toEqual(['card_unconfirmed', 'changing', 'done', 'expired', 'failed', 'open', 'rejected', 'review_only', 'skipped', 'stale', 'uncertain', 'undone', 'unverified']);
    for (const state of Object.values(APP_APPROVAL_STATE)) expect(appApprovalStateV1Schema.safeParse(state).success).toBe(true);
    expect(APP_APPROVAL_STATE).toMatchObject({ changing: 'edit_requested', rejected: 'not_done', failed: 'not_done', stale: 'not_done', uncertain: 'outcome_unknown', unverified: 'outcome_unknown', card_unconfirmed: 'unconfirmed' });

    const { appCaller } = await import('../src/channels/surfaces/app');
    const { appApprovalParts } = await import('../src/channels/approvals');
    const { ownerEffectLedger } = await import('../src/channels/owner-effect-ledger');
    const { sha256Hex } = await import('../src/connectors/google');
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-projection-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql; let n = 0; let now = NOW;
      const client = { createEvent: async () => ({ id: 'ev1', etag: 'e1' }), event: async () => ({ id: 'ev1', etag: 'e1', status: 'confirmed' }) } as unknown as GoogleClient;
      const before = { id: 't1', task_list_id: 'l1', title: 'Buy milk', status: 'todo' as const, notes: null, due_date: null, etag: '"e1"', parent: null, deleted: false, assigned: false };
      const args = { source: 'google_tasks' as const, action: 'update' as const, task_list_id: 'l1', task_id: 't1', changes: { title: 'Buy oat milk', due_date: '2026-10-12' }, reason: 'Owner asked' };
      const desk = approvalDesk(sql, { owner: 42, newId: () => `proj${++n}`, now: () => now, timezone: 'UTC', log: () => {}, appIdentity: () => true, google: async () => client,
        call: async (method: string) => method === 'sendMessage' ? { message_id: 900 + n, chat: { id: 42 } } : true,
        effects: ownerEffectLedger(state.storage, () => now),
        googleTasks: () => ({ prepare: async () => ({ args, account: { connection_id: 'conn-1', email: 'me@example.com' }, list: { id: 'l1', title: 'Errands', etag: '"le"' }, before }) }) as never });
      const calendar = await desk.propose({ action: 'create', title: 'Walk', start: iso('2026-10-10T15:00:00Z'), end: iso('2026-10-10T15:30:00Z'), reason: 'afternoon slot' });
      const raw = 'To: a@x.test\r\nSubject: Hi\r\n\r\nHello';
      const email = await desk.proposeSendEmail({ account: 'me@example.com', to: ['a@x.test'], cc: ['c@x.test'], subject: 'Hi', body: 'Hello', message_id: '<proj@waldo-send>', raw, digest: await sha256Hex(raw) });
      const message = await desk.proposeSendMessage({ channel: 'whatsapp', content: 'Running late.', idempotency_key: 'proj-1' });
      const page = { url: 'https://reservations.example/book?party=4&hold=secret-hold#slot', action: { selector: '#book', description: 'Book the table' }, binding: { time: '18:30', card: 'ending 4242' }, steps: [] };
      const browser = await desk.proposeBrowserSubmit(page);
      const mcp = await desk.proposeMcpCall({ server: 'crm', tool: 'lookup', args: { q: 'secret-ish' } });
      const task = await desk.proposeGoogleTaskChange(args);
      desk.record('email_draft', 'Drafted "Hi"', { draft: true });
      const listed = await desk.approvals(now);
      expect(listed.map(item => item.approval_id).sort()).toEqual([browser, calendar, email, mcp, message, task].sort());
      for (const item of listed) expect(appApprovalV1Schema.safeParse(item).success).toBe(true);
      const byId = Object.fromEntries(listed.map(item => [item.approval_id, item]));
      expect(byId[calendar]).toMatchObject({ kind: 'calendar_change', state: 'open', actions: ['approve', 'edit', 'skip'], expires_at: Date.parse('2026-10-10T15:00:00Z'),
        exact: { changes: { action: 'create', title: 'Walk', start: '2026-10-10T15:00:00Z', end: '2026-10-10T15:30:00Z' } } });
      expect([...byId[calendar]!.presented_surfaces!].sort()).toEqual(['app', 'telegram']);
      expect(byId[email]!.exact).toEqual({ recipients: { to: ['a@x.test'], cc: ['c@x.test'], bcc: [] }, scope: 'me@example.com' });
      expect(byId[email]!.review).toContain('Cc: c@x.test');
      expect(byId[message]!.exact).toEqual({ recipients: { to: ['whatsapp'], cc: [], bcc: [] } });
      expect(byId[browser]).toMatchObject({ exact: { scope: 'https://reservations.example/book' }, actions: ['skip'], review: 'Approve a browser action on https://reservations.example/book?', expires_at: NOW + 30 * 60_000 });
      expect(byId[mcp]).toMatchObject({ exact: { scope: 'lookup on the crm server' }, actions: ['skip'], review: 'Run lookup on the crm server.' });
      for (const id of [browser, mcp]) expect(desk.placement(id)).toEqual({ here: true, hereApprovable: true, app: true, appApprovable: false });
      expect(JSON.stringify(listed)).not.toMatch(/secret-ish|secret-hold|18:30|4242|party=/);
      const fromApp = approvalDesk(sql, { owner: 7_000_000_000_001, surface: 'app', call: appCaller(), newId: () => `proj${++n}`, now: () => now, timezone: 'UTC', log: () => {}, google: async () => null, currentRunRef: () => 'app-run-0001' });
      const appBrowser = await fromApp.proposeBrowserSubmit(page), appMcp = await fromApp.proposeMcpCall({ server: 'crm', tool: 'lookup', args: { q: 'secret-ish' } });
      const parts = appApprovalParts(sql)('app-run-0001');
      expect(parts.map(part => [part.approval_id, part.actions])).toEqual([[appBrowser, ['skip']], [appMcp, ['skip']]]);
      expect(JSON.stringify(parts)).not.toMatch(/secret-ish|secret-hold|18:30|4242|party=/);
      expect(parts.map(part => part.fallback_text)).toEqual(['Approve a browser action on https://reservations.example/book?', 'Run lookup on the crm server.']);
      expect((await fromApp.decide(appMcp, 'a', 'trace')).toast).toBe('Already handled.');
      expect((await desk.approvals(now, { id: appMcp }))[0]).toMatchObject({ state: 'review_only', actions: ['skip'] });
      expect(byId[task]!.exact).toEqual({ task: { action: 'update', account: 'me@example.com', list: 'Errands', task: 'Buy milk', changes: { title: { before: 'Buy milk', after: 'Buy oat milk' }, due_date: { before: null, after: '2026-10-12' } } } });
      for (const item of listed) {
        const stored = sql.exec<{ payload_json: string; proposal_digest: string | null }>('SELECT payload_json, proposal_digest FROM ledger WHERE id = ?', item.approval_id).one();
        expect(item.payload_digest).toBe(`sha256:${await sha256Hex(stored.payload_json)}`);
        if (item.kind === 'google_task_change') expect(item.payload_digest).toBe(`sha256:${stored.proposal_digest}`);
      }
      expect((await desk.approvals(now, { state: 'open' })).length).toBe(6);
      expect((await desk.approvals(now, { state: 'review_only' })).map(item => item.approval_id).sort()).toEqual([appBrowser, appMcp].sort());
      expect(await desk.approvals(now, { state: 'done' })).toEqual([]);
      expect((await desk.approvals(now, { id: email })).map(item => item.approval_id)).toEqual([email]);

      expect((await desk.decide(calendar, 'a', 'trace', { surface: 'app' })).toast).toBe('Done');
      expect((await desk.decide(message, 's', 'trace', { surface: 'app' })).toast).toBe('Not now');
      const done = (await desk.approvals(now, { id: calendar }))[0]!;
      expect(done).toMatchObject({ state: 'done', actions: ['undo'] });
      expect((await desk.approvals(now + 11 * 60_000, { id: calendar }))[0]).toMatchObject({ state: 'done', actions: [] });
      expect((await desk.approvals(now, { id: message }))[0]).toMatchObject({ state: 'skipped', actions: [] });
      expect((await desk.approvals(now, { state: 'done' })).map(item => item.approval_id)).toEqual([calendar]);
    });

    const legacyStub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-projection-legacy-${crypto.randomUUID()}`));
    await runInDurableObject(legacyStub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec('CREATE TABLE ledger (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL, undo_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)');
      sql.exec("INSERT INTO ledger VALUES ('pold1', 'message_send', 'open', 'Send this on telegram: \"Hi\"', ?, NULL, ?, NULL)", JSON.stringify({ channel: 'telegram', content: 'Hi', idempotency_key: 'old-1' }), NOW);
      const desk = approvalDesk(sql, { owner: 42, newId: () => 'unused', now: () => NOW, timezone: 'UTC', log: () => {}, google: async () => null, call: async () => ({ message_id: 1 }), sendMessage: async () => ({ provider_id: 'tg-1' }) });
      const [legacy] = await desk.approvals(NOW);
      expect(legacy).toMatchObject({ approval_id: 'pold1', state: 'open', actions: ['skip'] });
      expect(legacy!.presented_surfaces).toBeUndefined();
      expect((await desk.decide('pold1', 'a', 'trace', { surface: 'app' })).toast).toBe('Not available here');
      expect((await desk.decide('pold1', 'a', 'trace', { surface: 'telegram' })).toast).toBe('Sent');
    });
  });
});

describe('decisions from any surface', () => {
  const NOW = Date.UTC(2026, 9, 10, 9, 0, 0);
  it('two surface desks on one owner decide one proposal once, and the first decision retires the other cards', async () => {
    const { appApprovalLink, appCaller } = await import('../src/channels/surfaces/app');
    const { ownerEffectLedger } = await import('../src/channels/owner-effect-ledger');
    const { sha256Hex } = await import('../src/connectors/google');
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-any-surface-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      let n = 0, sends = 0; const telegram: { method: string; body: Record<string, unknown> }[] = []; const retired: unknown[] = [];
      const client = { sendRaw: async () => { sends++; return { message_id: 'g1' }; }, findSentByMessageId: async (id: string) => ({ message_id: 'g1', thread_id: 't', rfc822_message_id: id, label_ids: ['SENT'] }) } as unknown as GoogleClient;
      const shared = { google: async () => client, newId: () => `any${++n}`, now: () => NOW, timezone: 'UTC', log: () => {}, appIdentity: () => true, appLink: appApprovalLink,
        effects: ownerEffectLedger(state.storage, () => NOW), ownerRef: () => 'prn_10000000000000000000000000000001', ownerRefAliases: () => ['42'], retire: async (p: unknown) => { retired.push(p); } };
      const onTelegram = approvalDesk(state.storage.sql, { ...shared, owner: 42, call: async (method, body) => { telegram.push({ method, body: body as Record<string, unknown> }); return method === 'sendMessage' ? { message_id: telegram.length, chat: { id: 42 } } : true; } });
      const inApp = approvalDesk(state.storage.sql, { ...shared, owner: 7_000_000_000_001, surface: 'app', call: appCaller() });
      const raw = 'To: a@x.test\r\nSubject: Hi\r\n\r\nHello';
      const id = await onTelegram.proposeSendEmail({ to: ['a@x.test'], subject: 'Hi', body: 'Hello', message_id: '<any@waldo-send>', raw, digest: await sha256Hex(raw) });
      const card = telegram.find(call => call.method === 'sendMessage')!;
      expect((await inApp.decide(id, 'a', 'trace', { surface: 'app' })).toast).toBe('Sent');
      expect(sends).toBe(1);
      expect([...state.storage.kv.list<{ owner_ref: string }>({ prefix: 'owner:effect:' })].map(([, record]) => record.owner_ref)).toEqual(['prn_10000000000000000000000000000001']);
      expect(retired).toEqual([{ surface: 'telegram', message_ref: `42:${telegram.indexOf(card) + 1}` }]);
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM approval_presentations WHERE approval_id = ? AND retired_at IS NULL', id).one().n).toBe(0);
      telegram.length = 0;
      await onTelegram.callback({ id: 'late', from: { id: 42 }, data: `a:${id}`, message: { message_id: 1, chat: { id: 42 } } }, 'trace');
      expect(telegram.find(call => call.method === 'answerCallbackQuery')?.body.text).toBe('Already handled.');
      expect(sends).toBe(1);

      retired.length = 0;
      const second = await onTelegram.proposeSendEmail({ to: ['b@x.test'], subject: 'Hi', body: 'Hello', message_id: '<any2@waldo-send>', raw, digest: await sha256Hex(raw) });
      const tapped = telegram.filter(call => call.method === 'sendMessage').at(-2)!;
      await onTelegram.callback({ id: 'tap', from: { id: 42 }, data: `s:${second}`, message: { message_id: telegram.indexOf(tapped) + 1, chat: { id: 42 } } }, 'trace');
      expect(retired).toEqual([]);
      expect((await inApp.decide(second, 'a', 'trace', { surface: 'app' })).toast).toBe('Already handled.');
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM approval_presentations WHERE approval_id = ? AND retired_at IS NULL", second).one().n).toBe(0);
    });
  });

  it('a message to a channel this Waldo cannot send on is refused before it is claimed, and the console needs a full-review card', async () => {
    const { appCaller } = await import('../src/channels/surfaces/app');
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-any-surface-send-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      let n = 0; const sent: string[] = [];
      const desk = approvalDesk(state.storage.sql, { owner: 7_000_000_000_001, surface: 'app', call: appCaller(), google: async () => null, newId: () => `send${++n}`, now: () => NOW, timezone: 'UTC', log: () => {},
        canSendMessage: channel => channel === 'telegram', sendMessage: async proposal => { sent.push(`${proposal.channel}:${proposal.content}`); return { provider_id: 'tg-9' }; } });
      const whatsapp = await desk.proposeSendMessage({ channel: 'whatsapp', content: 'Hi', idempotency_key: 'wa-1' });
      expect((await desk.decide(whatsapp, 'a', 'trace')).toast).toBe('Channel not connected');
      expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', whatsapp).one().status).toBe('open');
      expect([...state.storage.kv.list({ prefix: 'owner:effect:' })]).toEqual([]);
      const telegram = await desk.proposeSendMessage({ channel: 'telegram', content: 'On my way', idempotency_key: 'tg-1' });
      expect((await desk.decide(telegram, 'a', 'trace', { surface: 'console' })).toast).toBe('Sent');
      expect(sent).toEqual(['telegram:On my way']);
      const blocked = approvalDesk(state.storage.sql, { owner: 42, call: async () => undefined, google: async () => null, newId: () => `send${++n}`, now: () => NOW, timezone: 'UTC', log: () => {} });
      await expect(blocked.proposeSendMessage({ channel: 'telegram', content: 'x', idempotency_key: 'tg-2' })).rejects.toThrow('Approval card not confirmed');
      expect((await desk.decide(`send${n}`, 'a', 'trace', { surface: 'console' })).toast).toBe('Already handled.');
    });
  });

  it('shows a cleared due date in the app, and presents no app card the app approvals list could not show', async () => {
    const { appCaller } = await import('../src/channels/surfaces/app');
    const { ownerEffectLedger } = await import('../src/channels/owner-effect-ledger');
    const { sha256Hex } = await import('../src/connectors/google');
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-any-surface-exact-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      let n = 0;
      const before = { id: 't1', task_list_id: 'l1', title: 'Buy milk', status: 'todo' as const, notes: null, due_date: '2026-10-12', etag: '"e1"', parent: null, deleted: false, assigned: false };
      const clearDue = { source: 'google_tasks' as const, action: 'update' as const, task_list_id: 'l1', task_id: 't1', changes: { due_date: null }, reason: 'No deadline any more' };
      const shared = { google: async () => null, newId: () => `exact${++n}`, now: () => NOW, timezone: 'UTC', log: () => {}, effects: ownerEffectLedger(state.storage, () => NOW),
        googleTasks: () => ({ prepare: async () => ({ args: clearDue, account: { connection_id: 'conn-1', email: 'me@example.com' }, list: { id: 'l1', title: 'Errands', etag: '"le"' }, before }) }) as never };
      const inApp = approvalDesk(state.storage.sql, { ...shared, owner: 7_000_000_000_001, surface: 'app', call: appCaller() });
      const cleared = await inApp.proposeGoogleTaskChange(clearDue);
      expect((await inApp.approvals(NOW, { id: cleared }))[0]).toMatchObject({ state: 'open', actions: ['approve', 'edit', 'skip'],
        exact: { task: { action: 'update', task: 'Buy milk', changes: { due_date: { before: '2026-10-12', after: null } } } } });

      const crowd = Array.from({ length: 101 }, (_, i) => `guest${i}@x.test`);
      const raw = 'To: many\r\nSubject: Party\r\n\r\nCome along';
      const party = { to: crowd, subject: 'Party', body: 'Come along', message_id: '<party@waldo-send>', raw, digest: await sha256Hex(raw) };
      await expect(inApp.proposeSendEmail(party)).rejects.toThrow('card_unconfirmed');
      const appRow = state.storage.sql.exec<{ id: string; status: string }>("SELECT id, status FROM ledger WHERE kind = 'email_send'").one();
      expect(appRow.status).toBe('card_unconfirmed');
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM approval_presentations WHERE approval_id = ?', appRow.id).one().n).toBe(0);
      const onTelegram = approvalDesk(state.storage.sql, { ...shared, owner: 42, appIdentity: () => true, call: async (method: string) => method === 'sendMessage' ? { message_id: 77, chat: { id: 42 } } : true });
      const shown = await onTelegram.proposeSendEmail({ ...party, message_id: '<party2@waldo-send>' });
      expect(state.storage.sql.exec<{ surface: string }>('SELECT surface FROM approval_presentations WHERE approval_id = ?', shown).toArray()).toEqual([{ surface: 'telegram' }]);
      expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', shown).one().status).toBe('open');
    });
  });

  it('a retire that throws does not revert the decision', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-any-surface-retire-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const logs: import('../src/channels/telegram-listener').TurnLogEntry[] = []; let sent = 0;
      const desk = approvalDesk(state.storage.sql, { owner: 42, google: async () => null, newId: () => 'retire1', now: () => NOW, timezone: 'UTC', log: entry => logs.push(entry), appIdentity: () => true,
        call: async (method: string) => method === 'sendMessage' ? { message_id: 5, chat: { id: 42 } } : true, sendMessage: async () => { sent++; return { provider_id: 'tg-5' }; },
        retire: async () => { throw Error('telegram unreachable'); } });
      const id = await desk.proposeSendMessage({ channel: 'telegram', content: 'Hi', idempotency_key: 'retire-1' });
      expect((await desk.decide(id, 'a', 'trace', { surface: 'app' })).toast).toBe('Sent');
      expect(sent).toBe(1);
      expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('done');
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM approval_presentations WHERE approval_id = ? AND retired_at IS NULL', id).one().n).toBe(0);
      expect(logs.some(entry => entry.hop === 'approval_retire' && entry.code === 'retire_failed')).toBe(true);
    });
  });

  it('a WhatsApp reply, which carries message_id 0, decides through the WhatsApp card it answers', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-any-surface-whatsapp-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const sent: string[] = []; const answers: string[] = [];
      const desk = approvalDesk(state.storage.sql, { owner: 447700900123, surface: 'whatsapp', google: async () => null, newId: () => 'wa1', now: () => NOW, timezone: 'UTC', log: () => {},
        call: async (method: string, body: object) => { if (method === 'answerCallbackQuery') answers.push(String((body as { text?: string }).text)); return method === 'sendMessage' ? { messaging_product: 'whatsapp', messages: [{ id: 'wamid.card-1' }] } : undefined; },
        sendMessage: async proposal => { sent.push(proposal.content); return { provider_id: 'wamid.sent-1' }; } });
      const id = await desk.proposeSendMessage({ channel: 'whatsapp', content: 'On my way', idempotency_key: 'wa-1' });
      expect(state.storage.sql.exec<{ surface: string; message_ref: string }>('SELECT surface, message_ref FROM approval_presentations WHERE approval_id = ?', id).toArray()).toEqual([{ surface: 'whatsapp', message_ref: 'wamid.card-1' }]);
      await desk.callback({ id: 'wa-reply', from: { id: 447700900123 }, data: `a:${id}`, message: { message_id: 0, chat: { id: 447700900123 } } }, 'trace');
      expect(answers).toEqual(['Sent']);
      expect(sent).toEqual(['On my way']);
    });
  });

  it('tool results say where the card actually landed', async () => {
    const { sendMessageHandler } = await import('../src/tools/live/messaging');
    const { callMcpToolHandler } = await import('../src/tools/live/mcp');
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-any-surface-tool-status-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      let n = 0, telegramUp = true;
      const desk = approvalDesk(state.storage.sql, { owner: 42, google: async () => null, newId: () => `tool${++n}`, now: () => NOW, timezone: 'UTC', log: () => {}, appIdentity: () => true,
        call: async (method: string) => method === 'sendMessage' ? (telegramUp ? { message_id: n, chat: { id: 42 } } : undefined) : true });
      const send = sendMessageHandler(desk), mcp = callMcpToolHandler(JSON.stringify([{ name: 'crm', url: 'https://mcp.test/rpc' }]), desk);
      const status = (result: unknown) => (result as { data: { status: string } }).data.status;
      expect(status(await send.handle({ channel: 'telegram', content: 'Hi', idempotency_key: 'status-1' }, {} as never))).toBe('sent to the owner with Send it / Modify / Not now buttons');
      telegramUp = false;
      expect(status(await send.handle({ channel: 'telegram', content: 'Hi again', idempotency_key: 'status-2' }, {} as never))).toBe('The review card is in the Waldo app; it could not be shown here. Nothing was sent.');
      expect(status(await mcp.handle({ server: 'crm', tool: 'lookup', args: { q: 'x' } }, {} as never))).toBe('Only a summary card could be shown, so it cannot be approved yet. Nothing has run.');
      const inApp = approvalDesk(state.storage.sql, { owner: 7_000_000_000_001, surface: 'app', call: async () => undefined, google: async () => null, newId: () => `tool${++n}`, now: () => NOW, timezone: 'UTC', log: () => {} });
      const fromApp = status(await callMcpToolHandler(JSON.stringify([{ name: 'crm', url: 'https://mcp.test/rpc' }]), inApp).handle({ server: 'crm', tool: 'lookup', args: { q: 'x' } }, {} as never));
      expect(fromApp).toBe('Only a summary card could be shown, so it cannot be approved yet. Nothing has run.');
      expect(fromApp).not.toMatch(/Do it/);
      telegramUp = true;
      const { proposalStatus } = await import('../src/channels/approvals');
      const { sha256Hex } = await import('../src/connectors/google');
      const raw = `To: a@x.test\r\nSubject: Long\r\n\r\n${'x'.repeat(5000)}`;
      const long = await desk.proposeSendEmail({ to: ['a@x.test'], subject: 'Long', body: 'x'.repeat(5000), message_id: '<status-long@waldo-send>', raw, digest: await sha256Hex(raw) });
      expect(desk.placement(long)).toEqual({ here: true, hereApprovable: false, app: true, appApprovable: true });
      expect(proposalStatus(desk.placement(long), 'review card requested in chat; nothing was sent', 'Nothing was sent.')).toBe('The full review card is in the Waldo app; it could not be shown in full here. Nothing was sent.');
    });
  });
});
