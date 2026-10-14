import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import type { GoogleClient } from '../src/connectors/google';

const iso = (s: string) => s as never;

// The console renders a stored review itself, so a card shown anywhere would serve it. The desk still lets it approve one
// kind only, a calendar change without invite details: the route rule (consoleMayApprove) is not the only guard.
it('the console approves a plain calendar change and no other kind, whatever card was shown', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('approval-console-scope')), async (_instance, state) => {
    const effects: string[] = [];
    let n = 0;
    const client = {
      account: { connection_id: 'local:owner@example.com', email: 'owner@example.com' },
      event: async (id: string) => ({ id, title: 'Walk', start: '2026-09-26T07:00:00+05:30', end: '2026-09-26T07:30:00+05:30', all_day: false, etag: 'v1' }),
      createEvent: async () => { effects.push('create'); return { id: 'new1', title: 'Walk', start: '', end: '', all_day: false, etag: 'v2' }; },
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, {
      call: async () => ({}), owner: 42, google: async () => client, newId: () => String(++n), now: () => 1_000_000, timezone: 'Asia/Kolkata', log: () => undefined,
      mcpCall: async () => { effects.push('mcp'); return 'ran'; },
      canSendMessage: () => true, sendMessage: async () => { effects.push('send'); return { provider_id: 'tg-1' }; },
    });
    const mcp = await desk.proposeMcpCall({ server: 'github', tool: 'merge_pr', args: { number: 1 } });
    const message = await desk.proposeSendMessage({ channel: 'telegram', content: 'On my way', idempotency_key: 'm-1' });
    for (const id of [mcp, message]) {
      expect((await desk.decide(id, 'a', 'trace', { surface: 'console' })).toast).toBe('Not available here');
      expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('open');
    }
    expect(effects).toEqual([]);
    const walk = await desk.propose({ action: 'create', title: 'Walk', start: iso('2026-09-26T07:00:00+05:30'), end: iso('2026-09-26T07:30:00+05:30'), reason: 'morning' });
    await desk.decide(walk, 'a', 'trace', { surface: 'console' });
    expect(effects).toEqual(['create']);
    expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', walk).one().status).toBe('done');
  });
});
