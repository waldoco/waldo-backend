import { describe, expect, it } from 'vitest';
import { googleHandlers } from '../src/tools/live/google';
import type { EmailSendProposal } from '../src/channels/approvals';
import { selectMailSender } from '../src/tools/live/google';
import { draftEmailArgsSchema, sendEmailArgsSchema } from '@waldo/contracts';

// Live failure tg-904957562: the model substituted draft_email for send_email, then claimed a
// draft hook pause AND a visible approval card. Neither existed. These tests pin the receipt
// contract the model's claims must match: send_email returns the desk-issued proposal_id (the
// same id behind the Telegram card and the console Waiting-on-you row), draft_email can never
// mint one.
const clock = { timezone: 'UTC', now: () => new Date('2026-09-25T10:00:00Z') };

const ctxAt = (started_at: number) => ({ authenticatedUserId: 'owner-1', session: { rate_limit_window: { started_at } } }) as never;

const deskWith = () => {
  const proposals: EmailSendProposal[] = [];
  return {
    proposals,
    desk: {
      propose: async () => 'p-cal',
      proposeSendEmail: async (payload: EmailSendProposal) => {
        proposals.push(payload);
        return { ok: true as const, id: 'p-real-1', reused: null };
      },
      record: () => undefined,
    },
  };
};

describe('email receipt truth', () => {
  const mailScopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose',
  ];
  const ownerAccount = { id: 'conn-1', email: 'owner@example.com', scopes: mailScopes };

  it('resolves self only with one healthy, mail-capable account before client/provider I/O', () => {
    expect(selectMailSender([], {}, true)).toBeNull();
    expect(selectMailSender([{ ...ownerAccount, scopes: null }], {}, true)).toBeNull();
    expect(selectMailSender([{ ...ownerAccount, scopes: ['openid'] }], {}, true)).toBeNull();
    expect(selectMailSender([ownerAccount], { 'conn-1': 'revoked' }, true)).toBeNull();
    expect(selectMailSender([ownerAccount, { ...ownerAccount, id: 'conn-2', email: 'other@example.com' }], {}, true)).toBeNull();
    expect(selectMailSender([ownerAccount], {}, true)).toEqual(ownerAccount);
  });

  it('accepts the explicit self token but never treats a redaction marker as an address or alias', () => {
    expect(draftEmailArgsSchema.safeParse({ to: ['self'], subject: 'S', body_markdown: 'B' }).success).toBe(true);
    expect(sendEmailArgsSchema.safeParse({ to: ['[REDACTED_EMAIL]'], subject: 'S', body_markdown: 'B' }).success).toBe(false);
    expect(draftEmailArgsSchema.safeParse({ to: ['[REDACTED_EMAIL]'], subject: 'S', body_markdown: 'B' }).success).toBe(false);
  });

  it('resolves self in a draft but never creates an approval card', async () => {
    const { desk, proposals } = deskWith();
    const drafted: unknown[] = [];
    const google = { client: async () => null, mailSender: async () => ({
      client: { draft: async (input: unknown) => { drafted.push(input); return { id: 'd-1' }; } } as never,
      connection: 'conn-1', email: 'owner@example.com',
    }) };
    const draft = googleHandlers(google, desk, clock).find((tool) => tool.name === 'draft_email')!;
    const result = await draft.handle({ to: ['self'], subject: 'S', body_markdown: 'B' } as never);
    expect(result.ok).toBe(true);
    expect(drafted).toMatchObject([{ to: ['owner@example.com'] }]);
    expect(proposals).toEqual([]);
  });

  it('does not create a draft or approval when self has no unique eligible sender', async () => {
    const { desk, proposals } = deskWith();
    let providerCalls = 0;
    const google = {
      client: async () => { providerCalls++; return null; },
      mailSender: async () => null,
    };
    const tools = googleHandlers(google, desk, clock);
    const args = { to: ['self'], subject: 'S', body_markdown: 'B' } as never;
    expect((await tools.find((tool) => tool.name === 'draft_email')!.handle(args)).ok).toBe(false);
    expect((await tools.find((tool) => tool.name === 'send_email')!.handle(args, ctxAt(1000))).ok).toBe(false);
    expect(providerCalls).toBe(0);
    expect(proposals).toEqual([]);
  });

  it('shows resolved To and pinned From in a send proposal; sender changes the dedupe key', async () => {
    const { desk, proposals } = deskWith();
    let sender = { email: 'owner@example.com', connection: 'conn-1' };
    const google = { client: async () => null, mailSender: async () => ({ client: {} as never, ...sender }) };
    const send = googleHandlers(google, desk, clock).find((tool) => tool.name === 'send_email')!;
    const args = { to: ['self'], subject: 'S', body_markdown: 'B' } as never;
    expect((await send.handle(args, ctxAt(1000))).ok).toBe(true);
    sender = { email: 'other@example.com', connection: 'conn-2' };
    expect((await send.handle(args, ctxAt(1000))).ok).toBe(true);
    expect(proposals[0]).toMatchObject({ from: 'owner@example.com', sender_connection: 'conn-1', to: ['owner@example.com'] });
    expect(proposals[1]).toMatchObject({ from: 'other@example.com', sender_connection: 'conn-2', to: ['other@example.com'] });
    expect(proposals[0]!.content_digest).not.toBe(proposals[1]!.content_digest);
  });
  it('send_email returns the desk-issued proposal_id and the exact content the card binds', async () => {
    const { desk, proposals } = deskWith();
    const google = { client: async () => ({}) as never, mailSender: async () => ({ client: {} as never, connection: 'conn-1', email: 'owner@example.com' }) };
    const send = googleHandlers(google, desk, clock).find((tool) => tool.name === 'send_email')!;
    const result = await send.handle({ to: ['priya@example.com'], subject: 'Deck', body_markdown: 'Ready Thursday.' } as never, ctxAt(1000));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { proposal_id: string; sent: boolean };
    // the claimable receipt is exactly the id the desk queued for both surfaces
    expect(data.proposal_id).toBe('p-real-1');
    expect(data.sent).toBe(false);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.to).toEqual(['priya@example.com']);
    expect(proposals[0]!.subject).toBe('Deck');
    expect(proposals[0]!.body).toBe('Ready Thursday.');
    expect(typeof proposals[0]!.digest).toBe('string');
  });

  it('draft_email can never mint an approval receipt: no proposal_id, no queue entry', async () => {
    const { desk, proposals } = deskWith();
    const google = { client: async () => ({ draft: async () => ({ id: 'd-1' }) }) as never, mailSender: async () => ({ client: { draft: async () => ({ id: 'd-1' }) } as never, connection: 'conn-1', email: 'owner@example.com' }) };
    const draft = googleHandlers(google, desk, clock).find((tool) => tool.name === 'draft_email')!;
    const result = await draft.handle({ to: ['priya@example.com'], subject: 'Deck', body_markdown: 'Ready Thursday.' } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as Record<string, unknown>).proposal_id).toBeUndefined();
    expect(proposals).toHaveLength(0);
  });

  it('scopes the Message-ID to the logical send: same-turn retries keep it, a new request or changed content gets a fresh one', async () => {
    const { desk, proposals } = deskWith();
    const google = { client: async () => ({}) as never, mailSender: async () => ({ client: {} as never, connection: 'conn-1', email: 'owner@example.com' }) };
    const send = googleHandlers(google, desk, clock).find((tool) => tool.name === 'send_email')!;
    await send.handle({ to: ['a@x.test'], subject: 'S', body_markdown: 'B' } as never, ctxAt(1000));
    await send.handle({ to: ['a@x.test'], subject: 'S', body_markdown: 'B' } as never, ctxAt(1000)); // same turn, same content: a retry
    await send.handle({ to: ['a@x.test'], subject: 'S', body_markdown: 'B' } as never, ctxAt(2000)); // new request, same content
    await send.handle({ to: ['a@x.test'], subject: 'S', body_markdown: 'B2' } as never, ctxAt(1000)); // same turn, changed content
    expect(proposals).toHaveLength(4);
    // retry of one logical send -> one Message-ID, so Sent-mail reconciliation proves exactly-once
    expect(proposals[0]!.message_id).toBe(proposals[1]!.message_id);
    // same content on a new request -> a NEW Message-ID: an old Sent hit can never alias it
    expect(proposals[0]!.message_id).not.toBe(proposals[2]!.message_id);
    // changed content in the same turn -> a NEW Message-ID
    expect(proposals[0]!.message_id).not.toBe(proposals[3]!.message_id);
  });

  it('the draft_email description tells the model it creates no approval card', () => {
    const { desk } = deskWith();
    const google = { client: async () => null };
    const draft = googleHandlers(google, desk, clock).find((tool) => tool.name === 'draft_email')!;
    expect(draft.description).toContain('NO approval card');
    expect(draft.description).toContain('send_email');
  });
});
