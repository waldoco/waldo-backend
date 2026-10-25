import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { appApprovalsRequest } from '../src/channels/app-approvals';
import { approvalDesk } from '../src/channels/approvals';
import { appApprovalLink, appCaller } from '../src/channels/surfaces/app';
import { emailProposal } from './fixtures/email-send';

// The list response for an email and a message approval, captured from beta-mvp 2aeb56de before the draft of a send
// existed. Builds that declare no revision, revision 1 or revision 2 parse that shape strictly, so they keep receiving it.
// @ts-expect-error vite-only API; this package carries no vite client types
const fixtures: Record<string, string> = import.meta.glob('./fixtures/app-approvals-sends-beta-mvp.json', { query: '?raw', import: 'default', eager: true });
const captured = Object.values(fixtures)[0];
const digestless = (text: string) => text.replace(/"payload_digest":"sha256:[0-9a-f]{64}"/g, '"payload_digest":"sha256:<payload>"');

it('a build that declares no revision, revision 1 or revision 2 gets the send approvals exactly as beta-mvp served them', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('app-approvals-sends-fixture')), async (_instance, state) => {
    let n = 0;
    const now = Date.UTC(2036, 0, 10, 9, 0);
    const desk = approvalDesk(state.storage.sql, { surface: 'app', owner: 7_000_000_000_001, call: appCaller(), appLink: appApprovalLink,
      google: async () => null, newId: () => `fx${++n}`, now: () => now, timezone: 'Asia/Kolkata', log: () => {}, currentRunRef: () => 'app-message-0001' });
    await desk.proposeSendEmail(await emailProposal({ to: ['sam@example.com'], cc: ['pat@example.org'], subject: 'Friday deck', body: 'Hi Sam,\n\nThe deck is ready — see slide 3.\n\nThanks', message_id: '<fixture@waldo-send>', account: 'owner@example.com' }));
    await desk.proposeSendMessage({ channel: 'telegram', content: 'Running ten minutes late.', idempotency_key: 'fixture-message-0001' });
    const host = { csrf: 'c'.repeat(64), expires: Date.now() + 3_600_000, storage: state.storage, assertCurrent: async () => {}, sessions: async () => [{ csrf: 'c'.repeat(64), expires: Date.now() + 3_600_000 }], desk };
    const list = async (header?: string) => (await appApprovalsRequest(new Request('https://telegram-owner/app/v1/approvals', { headers: header === undefined ? {} : { 'x-waldo-app-contract': header } }), host)).text();
    expect(captured).toBeDefined();
    for (const header of [undefined, 'approvals=1', 'approvals=2', 'threads=3']) expect([header, digestless(await list(header))]).toEqual([header, digestless(captured!.trimEnd())]);
  });
});
