// Owning ADRs: ADR-0012 (Telegram + APNs first, channel-adapter payloads) + ADR-0015
// (brief trigger with variant; variant present iff trigger is 'brief') + ADR-0067
// (narrow: account-event notices as a standalone, budget-exempt, zero-health class).
// Invariant under test: notification payloads are Art-9-safe by construction — stable
// IDs + zone words only, never raw physiological values or free text — and the
// account-event class is system-emitted (agent_invocable is the literal false, so the
// delivery invariant that agent-reachable exempt classes carry a non-null cap is
// satisfied vacuously).
// Failure mode caught: a numeric health field or addressing metadata drifting into a
// journal-bound payload; an agent-invocable account-event claim; the variant iff-brief
// law breaking in either direction.
import { describe, expect, it } from 'vitest';
import {
  accountEventClassSchema,
  accountEventKindSchema,
  accountEventNoticeSchema,
  pushNotificationSchema,
} from './notification';

const basePush = { trigger: 'fetch_alert', form_zone: 'flagging', card_ref: 'card-01' } as const;

const baseNotice = {
  push_class: 'account_event',
  event: 'bind',
  binding_version: 1,
  agent_invocable: false,
} as const;

describe('pushNotification', () => {
  it('accepts a zone-word alert payload with a stable card ref', () => {
    expect(pushNotificationSchema.safeParse(basePush).success).toBe(true);
  });

  it('accepts a brief payload carrying its variant', () => {
    expect(pushNotificationSchema.safeParse({ trigger: 'brief', variant: 'morning' }).success).toBe(
      true,
    );
  });

  it("rejects a brief payload missing its variant (present iff trigger is 'brief')", () => {
    expect(pushNotificationSchema.safeParse({ trigger: 'brief' }).success).toBe(false);
  });

  it('rejects a variant on a non-brief trigger', () => {
    expect(
      pushNotificationSchema.safeParse({ trigger: 'patrol', variant: 'midday' }).success,
    ).toBe(false);
  });

  it("rejects a retired trigger ('morning_wag')", () => {
    expect(pushNotificationSchema.safeParse({ ...basePush, trigger: 'morning_wag' }).success).toBe(
      false,
    );
  });

  it('rejects a raw-health-value field (hrv_ms)', () => {
    expect(pushNotificationSchema.safeParse({ ...basePush, hrv_ms: 42 }).success).toBe(false);
  });

  it('rejects a numeric score field (zone words only, strictObject)', () => {
    expect(pushNotificationSchema.safeParse({ ...basePush, form_score: 51 }).success).toBe(false);
  });

  it("rejects the Load word 'peak' in form_zone (vocabularies do not mix)", () => {
    expect(pushNotificationSchema.safeParse({ ...basePush, form_zone: 'peak' }).success).toBe(
      false,
    );
  });

  it('rejects an empty card_ref (stable IDs only)', () => {
    expect(pushNotificationSchema.safeParse({ ...basePush, card_ref: '' }).success).toBe(false);
  });
});

describe('accountEventKind', () => {
  it('is exactly the three ADR-0067 notice events, in order', () => {
    expect(accountEventKindSchema.options).toEqual(['bind', 'rebind', 'unlink']);
  });

  it('rejects an unknown event', () => {
    expect(accountEventKindSchema.safeParse('token_minted').success).toBe(false);
  });
});

describe('accountEventNotice', () => {
  it('accepts a zero-health bind notice', () => {
    expect(accountEventNoticeSchema.safeParse(baseNotice).success).toBe(true);
  });

  it("class literal is 'account_event' — the ADR-0067 alternate 'security_notice' is not it", () => {
    expect(accountEventClassSchema.parse('account_event')).toBe('account_event');
    expect(accountEventClassSchema.safeParse('security_notice').success).toBe(false);
  });

  it('rejects an agent-invocable claim (system-emitted only)', () => {
    expect(
      accountEventNoticeSchema.safeParse({ ...baseNotice, agent_invocable: true }).success,
    ).toBe(false);
  });

  it('rejects any health field, even a zone word (zero-health by construction)', () => {
    expect(
      accountEventNoticeSchema.safeParse({ ...baseNotice, recovery_zone: 'mixed' }).success,
    ).toBe(false);
  });

  it('rejects addressing metadata (handle resolves at flush time, never persisted here)', () => {
    expect(accountEventNoticeSchema.safeParse({ ...baseNotice, handle: '@user' }).success).toBe(
      false,
    );
  });

  it('rejects a non-positive binding_version', () => {
    expect(accountEventNoticeSchema.safeParse({ ...baseNotice, binding_version: 0 }).success).toBe(
      false,
    );
  });
});
