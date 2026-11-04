import { describe, expect, it } from 'vitest';
import { sendMessageHandler, type MessageDesk } from '../src/tools/live/messaging';
import type { MessageSendProposal } from '../src/channels/approvals';

describe('send_message handler', () => {
  it('proposes a card with the exact channel + content and never sends directly', async () => {
    const proposed: MessageSendProposal[] = [];
    const desk: MessageDesk = { proposeSendMessage: async (p) => { proposed.push(p); return 'p9'; } };
    const handler = sendMessageHandler(desk);
    const out = await handler.handle(
      { channel: 'telegram', content: 'Running 10 late', idempotency_key: 'k'.repeat(64) },
      {} as never,
    );
    expect(proposed).toEqual([{ channel: 'telegram', content: 'Running 10 late', idempotency_key: 'k'.repeat(64) }]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data).toMatchObject({ proposal_id: 'p9', sent: false });
      expect(out.source_taint).toBeNull();
    }
  });

  it('declares the ADR-0008 allowlist inverse of its ACLs', () => {
    const desk: MessageDesk = { proposeSendMessage: async () => 'p' };
    const handler = sendMessageHandler(desk);
    expect(handler.name).toBe('send_message');
    expect(handler.autonomy_gated).toBe(false);
    expect(handler.trigger_allowlist.length).toBeGreaterThan(0);
  });
});
