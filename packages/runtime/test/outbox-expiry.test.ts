import { describe, expect, it } from 'vitest';
import { expiredCode, WHATSAPP_COPY_PREFIX } from '../src/channels/proactive-surface';
import type { FinalRecord } from '../src/channels/telegram-final-outbox';

const record = (extra: Partial<FinalRecord> = {}): FinalRecord => ({
  id: 'r1', trace: 't', payload: { chat_id: 1, text: 'synthetic' }, digest: 'd', ownerSubject: '1', doName: 'owner',
  status: 'blocked', reason: 'expired', dueAt: 0, createdAt: 0, attempts: 0, ...extra,
});
const open = { windowClosed: false, quiet: false, volumeLow: false, followupsOff: false };

describe('an expired record names what it was and what held it', () => {
  it('names the kind of record', () => {
    expect(expiredCode(record({ id: `${WHATSAPP_COPY_PREFIX}r0` }), open)).toBe('expired:whatsapp_copy:waited');
    expect(expiredCode(record({ dayCard: { day: '2026-11-18', card: 'card:brief', foldUpTo: 0 } }), open)).toBe('expired:day_card:waited');
    expect(expiredCode(record({ update: { recordId: 3 }, revision: { day: '2026-11-18', card: 'card:brief' } }), open)).toBe('expired:revision:waited');
    expect(expiredCode(record({ update: { recordId: 3 } }), open)).toBe('expired:update_card:waited');
    expect(expiredCode(record({ announcement: { ids: ['a'] } }), open)).toBe('expired:announcement:waited');
    expect(expiredCode(record({ answersOwner: true }), open)).toBe('expired:answer:waited');
    expect(expiredCode(record(), open)).toBe('expired:message:waited');
  });

  it('names the hold, the closed WhatsApp window first', () => {
    const update = record({ update: { recordId: 3 } });
    expect(expiredCode(update, { ...open, windowClosed: true, quiet: true })).toBe('expired:update_card:window_closed');
    expect(expiredCode(update, { ...open, quiet: true, volumeLow: true })).toBe('expired:update_card:quiet');
    expect(expiredCode(update, { ...open, volumeLow: true })).toBe('expired:update_card:volume_low');
    expect(expiredCode(update, { ...open, followupsOff: true })).toBe('expired:update_card:followups_off');
  });
});
