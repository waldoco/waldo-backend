import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { approvalDesk } from '../src/channels/approvals';
import { googleHandlers } from '../src/tools/live/google';
import { workspaceToolHandlers } from '../src/tools/live/workspace';
import type { GoogleClient } from '../src/connectors/google';

it.each(['exact marker', 'missing marker', 'wrong marker'] as const)('calendar response loss reads back a stable event id before replay: %s', async evidence => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`effect-calendar-readback-${evidence}`));
  await runInDurableObject(stub, async (_instance, state) => {
    const effects = ownerEffectLedger(state.storage, () => 1000);
    let sends = 0; let eventId = ''; let marker = '';
    const start = '2026-10-08T10:00:00Z'; const end = '2026-10-08T11:00:00Z';
    const client = { createEvent: async (input: { id: string; operationMarker: string }) => { sends++; eventId = input.id; marker = input.operationMarker; expect(marker).toMatch(/^[0-9a-f]{64}$/); throw Error('lost response'); }, event: async (id: string) => { expect(id).toBe(eventId); return { id, title: 'Meeting', start, end, etag: 'applied', ...(evidence === 'missing marker' ? {} : { operation_marker: evidence === 'exact marker' ? marker : 'foreign-operation' }) }; } } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, { owner: 42, call: async () => ({}), google: async () => client, newId: () => 'one', now: () => 1000, timezone: 'UTC', log: () => {}, effects });
    const id = await desk.propose({ action: 'create', title: 'Meeting', start, end } as never);
    expect((await desk.decide(id, 'a', 'test')).toast).toBe(evidence === 'exact marker' ? 'Done' : 'Outcome unknown');
    expect(effects.get(`approval:${id}:apply`)?.receipt?.provider_id).toBe(evidence === 'exact marker' ? eventId : undefined);
    expect(sends).toBe(1);
    expect((await desk.decide(id, 'a', 'test')).toast).toBe(evidence === 'exact marker' ? 'Already handled.' : 'Outcome unknown');
    expect(sends).toBe(1);
  });
});

it('draft response loss reconciles by host Message-ID and reuses the receipt', async () => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('effect-draft-readback'));
  await runInDurableObject(stub, async (_instance, state) => {
    const effects = ownerEffectLedger(state.storage, () => 1000);
    let sends = 0; let messageId = '';
    const client = { draft: async (input: { messageId: string }) => { sends++; messageId = input.messageId; throw Error('lost response'); }, findDraftByMessageId: async (id: string) => { expect(id).toBe(messageId); return { draft_id: 'draft-provider' }; } } as unknown as GoogleClient;
    const handler = googleHandlers({ client: async () => client }, { propose: async () => '', proposeSendEmail: async () => '', record: () => {} }, { timezone: 'UTC', now: () => new Date(1000) }, undefined, effects).find(tool => tool.name === 'draft_email')!;
    const ctx = { authenticatedUserId: 'owner', turnId: 'turn', toolCallId: 'call' } as never;
    const args = { to: ['friend@example.test'], subject: 'Hi', body_markdown: 'Hello' };
    expect(await handler.handle(args as never, ctx)).toMatchObject({ ok: true, data: { draft_id: 'draft-provider', sent: false } });
    expect(await handler.handle(args as never, ctx)).toMatchObject({ ok: true });
    expect(sends).toBe(1);
  });
});

it('workspace response loss reconciles the exact revision without another write', async () => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('effect-workspace-readback'));
  await runInDurableObject(stub, async (_instance, state) => {
    const effects = ownerEffectLedger(state.storage, () => 1000);
    let writes = 0; let operation = '';
    const meta = { file_id: 'file', path: 'notes.md', revision: 1, mime: 'text/markdown', byte_size: 5, state: 'ready', sha256: 'digest', provenance: 'agent_generated' };
    const store = { write: async (args: { operation_id: string }) => { writes++; operation = args.operation_id; throw Error('lost response'); }, reconcile: async (id: string) => { expect(id).toBe(operation); return meta; } };
    const handler = workspaceToolHandlers(async () => store as never, undefined, effects).find(tool => tool.name === 'workspace_write')!;
    const ctx = { authenticatedUserId: 'owner', turnId: 'turn', toolCallId: 'call' } as never;
    const args = { path: 'notes.md', text: 'hello', mime: 'text/markdown', expected_revision: 0 };
    expect(await handler.handle(args as never, ctx)).toMatchObject({ ok: true, data: { file_id: 'file', revision: 1 } });
    expect(await handler.handle(args as never, ctx)).toMatchObject({ ok: true });
    expect(writes).toBe(1);
  });
});

it('browser commits reserve intent and only settle a host-checked provider receipt', async () => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('effect-browser-readback'));
  await runInDurableObject(stub, async (_instance, state) => {
    const effects = ownerEffectLedger(state.storage, () => 1000);
    const desk = approvalDesk(state.storage.sql, { owner: 42, call: async () => ({}), google: async () => null, newId: () => 'one', now: () => 1000, timezone: 'UTC', log: () => {}, effects,
      browserSubmit: async () => { expect(effects.get('approval:pone:apply')?.state).toBe('attempting'); return { status: 'verified_with_receipt', message: 'Verified', receipt: { id: 'provider-browser', source: 'provider', observed_at: 'now', action_digest: 'digest', binding_digest: 'digest' } }; },
      browserReceiptVerified: async () => true,
    });
    const id = await desk.proposeBrowserSubmit({ url: 'https://fixture.invalid', action: { selector: '#submit', description: 'Submit' }, binding: {}, steps: [] });
    expect((await desk.decide(id, 'a', 'test')).toast).toBe('Verified');
    expect(effects.get(`approval:${id}:apply`)?.receipt?.provider_id).toBe('provider-browser');
  });
});
