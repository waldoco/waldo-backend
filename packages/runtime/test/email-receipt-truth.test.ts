import { describe, expect, it } from 'vitest';
import { googleHandlers } from '../src/tools/live/google';
import type { EmailSendProposal } from '../src/channels/approvals';

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
        return { id: 'p-real-1', reused: null };
      },
      record: () => undefined,
    },
  };
};

describe('email receipt truth', () => {
  it('send_email returns the desk-issued proposal_id and the exact content the card binds', async () => {
    const { desk, proposals } = deskWith();
    const google = { client: async () => ({}) as never };
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
    const google = { client: async () => ({ draft: async () => ({ id: 'd-1' }) }) as never };
    const draft = googleHandlers(google, desk, clock).find((tool) => tool.name === 'draft_email')!;
    const result = await draft.handle({ to: ['priya@example.com'], subject: 'Deck', body_markdown: 'Ready Thursday.' } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as Record<string, unknown>).proposal_id).toBeUndefined();
    expect(proposals).toHaveLength(0);
  });

  it('scopes the Message-ID to the logical send: same-turn retries keep it, a new request or changed content gets a fresh one', async () => {
    const { desk, proposals } = deskWith();
    const google = { client: async () => ({}) as never };
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
