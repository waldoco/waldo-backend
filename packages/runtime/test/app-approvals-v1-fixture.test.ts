import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { appApprovalsRequest } from '../src/channels/app-approvals';
import { approvalDesk } from '../src/channels/approvals';
import { appApprovalLink, appCaller } from '../src/channels/surfaces/app';
import type { GoogleClient } from '../src/connectors/google';

// The no-header list response captured from beta-mvp 00e8586 before the calendar details existed. Installed builds
// pin that shape and parse it strictly, so a request that declares no revision must keep receiving it.
// @ts-expect-error vite-only API; this package carries no vite client types
const fixtures: Record<string, string> = import.meta.glob('./fixtures/app-approvals-v1-beta-mvp.json', { query: '?raw', import: 'default', eager: true });
const captured = Object.values(fixtures)[0];
// The digest covers the stored proposal, which now also keeps the review's time zone; it is opaque to the app.
const digestless = (text: string) => text.replace(/"payload_digest":"sha256:[0-9a-f]{64}"/g, '"payload_digest":"sha256:<payload>"');

it('a request that declares no contract revision gets the calendar approval list exactly as beta-mvp served it', async () => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName('app-approvals-v1-fixture'));
  await runInDurableObject(stub, async (_instance, state) => {
    let n = 0;
    const now = Date.UTC(2036, 0, 10, 9, 0);
    const client = {
      account: { connection_id: 'local:owner@example.com', email: 'owner@example.com' },
      event: async (id: string) => ({ id, title: 'Standup', start: '2036-01-14T18:00:00+05:30', end: '2036-01-14T18:15:00+05:30', all_day: false, etag: 'v1', attendees: 3 }),
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, { surface: 'app', owner: 7_000_000_000_001, call: appCaller(), appLink: appApprovalLink,
      google: async () => client, newId: () => `fx${++n}`, now: () => now, timezone: 'Asia/Kolkata', log: () => {}, currentRunRef: () => 'app-message-0001' });
    await desk.propose({ action: 'move', event_id: 'e1', title: 'Standup', start: '2036-01-16T18:30:00+05:30' as never, end: '2036-01-16T18:45:00+05:30' as never,
      calendar_id: 'team@group.calendar.google.com', send_updates: 'none', reason: 'clash' });
    await desk.propose({ action: 'create', title: 'Design review', start: '2036-01-17T10:00:00+05:30' as never, end: '2036-01-17T10:30:00+05:30' as never, reason: 'Sam asked',
      account: 'owner@example.com', attendees: ['sam@example.com', 'pat@example.org'], send_updates: 'all', location: 'Room 4' });
    await desk.propose({ action: 'cancel', event_id: 'e2', title: 'Standup', calendar_id: 'primary', reason: 'off' });
    const host = { csrf: 'c'.repeat(64), expires: Date.now() + 3_600_000, storage: state.storage, assertCurrent: async () => {}, sessions: async () => [{ csrf: 'c'.repeat(64), expires: Date.now() + 3_600_000 }], desk };
    const text = await (await appApprovalsRequest(new Request('https://telegram-owner/app/v1/approvals'), host)).text();
    expect(captured).toBeDefined();
    expect(digestless(text)).toBe(digestless(captured!.trimEnd()));
  });
});
