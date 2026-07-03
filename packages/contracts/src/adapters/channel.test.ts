// Owning ADRs: ADR-0012 (channel vocabulary + provider-agnostic ChannelAdapter seam) +
// ADR-0035 (persona slicing; card_kinds_allowed with the typed 'all' sentinel) + ADR-0039
// (message-tree binding, depth cap 4) + ADR-0067 (five-gate inbound contract, gate-2
// per-update-type shapes, bind/resolve/unbind, binding tombstone, limits constants).
// Invariants under test: channelName is single-owner and closed; persona coverage is
// deliberately partial (a channel literal without a persona — discord — is legal, so no
// completeness check demands one persona per literal); gate ordering is contract and
// gate-1 mismatch is the coded 401, never a 200 drop; bind failures carry no identity
// (the chat is no oracle); the unbind tombstone scrubs addressing but keeps the version
// fence; limits equal the ADR-0067 table verbatim.
// Failure modes caught: an unratified channel/state/code/gate literal added, removed, or
// reordered; a persona kind outside the card vocabulary; a group chat, bot sender,
// forward, edit, or media-only update becoming parseable; a bind failure leaking the
// bound user; a tombstone retaining addressing; a limits value drifting off the ADR pins.
import { describe, expect, it } from 'vitest';
import { accountEventNoticeSchema } from '../ui/notification';
import { waldoCardKindSchema } from '../ui/card';
import {
  bindResultCodeSchema,
  bindResultSchema,
  cardKindsAllowedSchema,
  CHANNEL_PERSONAS,
  channelBindingSchema,
  channelBindingStateSchema,
  channelMessageSchema,
  channelNameSchema,
  channelPeerSchema,
  channelPersonaSchema,
  channelSendReceiptSchema,
  gateCounterSchema,
  inboundDecisionSchema,
  inboundGateSchema,
  INBOUND_LIMITS,
  inboundLimitsSchema,
  IOS_PERSONA,
  LINK_TOKEN_TTL_MIN,
  linkTokenKindSchema,
  linkTokenSchema,
  MAX_MESSAGE_BRANCH_DEPTH,
  messageThreadBindingSchema,
  resolveResultSchema,
  SLACK_PERSONA,
  TELEGRAM_PERSONA,
  TELEGRAM_WEBHOOK_SECRET_HEADER,
  telegramCallbackQueryUpdateSchema,
  telegramInboundUpdateSchema,
  telegramMessageUpdateSchema,
  telegramMyChatMemberUpdateSchema,
  telegramUpdateTypeSchema,
  TG_BIND_CONFIRM_KIND,
  unbindReasonSchema,
  unbindResultSchema,
} from './channel';

const key = 'a'.repeat(64);

describe('channelName', () => {
  it('is exactly the six channel literals, in order', () => {
    expect(channelNameSchema.options).toEqual([
      'telegram',
      'apns',
      'whatsapp',
      'discord',
      'slack',
      'in_app',
    ]);
  });

  it("rejects an out-of-vocabulary channel ('sms')", () => {
    expect(channelNameSchema.safeParse('sms').success).toBe(false);
  });
});

describe('cardKindsAllowed', () => {
  it("accepts the 'all' sentinel and a kind subset", () => {
    expect(cardKindsAllowedSchema.safeParse('all').success).toBe(true);
    expect(cardKindsAllowedSchema.safeParse(['context_card', 'brief_card']).success).toBe(true);
  });

  it("rejects a bare string other than 'all'", () => {
    expect(cardKindsAllowedSchema.safeParse('everything').success).toBe(false);
  });

  it("rejects an array containing a retired kind ('sheet_write')", () => {
    expect(cardKindsAllowedSchema.safeParse(['context_card', 'sheet_write']).success).toBe(false);
  });
});

describe('channelPersona', () => {
  it('every shipped persona parses and sits under its own channel key', () => {
    for (const [channel, persona] of Object.entries(CHANNEL_PERSONAS)) {
      expect(channelPersonaSchema.safeParse(persona).success).toBe(true);
      expect(persona.channel).toBe(channel);
    }
  });

  it('persona coverage is deliberately partial: telegram, apns, slack — and no more', () => {
    // discord ships as vocabulary only; whatsapp adopts warm_personal on platform
    // approval (ADR-0012). Adding a persona is a ratified change, not a drive-by.
    expect(Object.keys(CHANNEL_PERSONAS)).toEqual(['telegram', 'apns', 'slack']);
  });

  it('tone vocabulary is exactly the three ADR-0035 registers, in order', () => {
    expect(channelPersonaSchema.shape.tone.options).toEqual([
      'warm_personal',
      'structured_visual',
      'professional_work',
    ]);
  });

  it('pins the ADR-0035 telegram persona values', () => {
    expect(TELEGRAM_PERSONA.verbosity_ceiling_tokens).toBe(180);
    expect(TELEGRAM_PERSONA.health_data_redaction).toBe('none');
    expect(TELEGRAM_PERSONA.card_kinds_allowed).toEqual([
      'adjustment_proposal',
      'window_proposal',
      'fetch_card',
      'brief_card',
      'skill_proposal',
      'draft_email_card',
      'context_card',
    ]);
  });

  it("pins the iOS persona: 'all' kinds, tighter ceiling, no signoff", () => {
    expect(IOS_PERSONA.card_kinds_allowed).toBe('all');
    expect(IOS_PERSONA.verbosity_ceiling_tokens).toBe(120);
    expect(IOS_PERSONA.signoff_style).toBe('none');
  });

  it('pins the slack persona: work_filter, descriptions only, no acute-health fetch_card', () => {
    expect(SLACK_PERSONA.health_data_redaction).toBe('work_filter');
    expect(SLACK_PERSONA.raw_value_policy).toBe('show_descriptions_only');
    expect(SLACK_PERSONA.card_kinds_allowed).toEqual([
      'adjustment_proposal',
      'window_proposal',
      'context_card',
      'draft_email_card',
    ]);
  });

  it('every persona card kind is a member of the card vocabulary (single owner)', () => {
    for (const persona of Object.values(CHANNEL_PERSONAS)) {
      if (persona.card_kinds_allowed === 'all') continue;
      for (const kind of persona.card_kinds_allowed) {
        expect(waldoCardKindSchema.options).toContain(kind);
      }
    }
  });

  it('rejects an unknown tone', () => {
    expect(
      channelPersonaSchema.safeParse({ ...TELEGRAM_PERSONA, tone: 'sassy' }).success,
    ).toBe(false);
  });

  it('rejects an extra field (strictObject)', () => {
    expect(
      channelPersonaSchema.safeParse({ ...TELEGRAM_PERSONA, soul_file: 'warm' }).success,
    ).toBe(false);
  });

  it('rejects a non-positive verbosity ceiling', () => {
    expect(
      channelPersonaSchema.safeParse({ ...TELEGRAM_PERSONA, verbosity_ceiling_tokens: 0 }).success,
    ).toBe(false);
  });
});

const baseMessage = {
  channel: 'telegram',
  text: 'nudged your 9am to 10:30',
  cards: [],
  idempotency_key: key,
} as const;

describe('channelMessage', () => {
  it('accepts a sliced text-only message', () => {
    expect(channelMessageSchema.safeParse(baseMessage).success).toBe(true);
  });

  it('rejects an extra field (strictObject)', () => {
    expect(channelMessageSchema.safeParse({ ...baseMessage, chat_id: '42' }).success).toBe(false);
  });

  it('rejects an upper-hex idempotency key (single canonical form)', () => {
    expect(
      channelMessageSchema.safeParse({ ...baseMessage, idempotency_key: 'A'.repeat(64) }).success,
    ).toBe(false);
  });

  it('rejects empty text', () => {
    expect(channelMessageSchema.safeParse({ ...baseMessage, text: '' }).success).toBe(false);
  });

  it('rejects a card disallowed by the target channel persona', () => {
    expect(
      channelMessageSchema.safeParse({
        ...baseMessage,
        channel: 'slack',
        cards: [{ kind: 'fetch_card', card_id: 'fetch-01', data: { source_refs: ['crs-01'] } }],
      }).success,
    ).toBe(false);
  });

  it("accepts an iOS message with a fetch card because the apns persona allows 'all'", () => {
    expect(
      channelMessageSchema.safeParse({
        ...baseMessage,
        channel: 'apns',
        cards: [{ kind: 'fetch_card', card_id: 'fetch-01', data: { source_refs: ['crs-01'] } }],
      }).success,
    ).toBe(true);
  });
});

describe('messageThreadBinding', () => {
  it('accepts a top-level message (no parent, depth 0) and a branched one', () => {
    expect(
      messageThreadBindingSchema.safeParse({
        thread_id: 'thread-01',
        parent_message_id: null,
        branch_depth: 0,
      }).success,
    ).toBe(true);
    expect(
      messageThreadBindingSchema.safeParse({
        thread_id: 'thread-01',
        parent_message_id: 'msg-01',
        branch_depth: MAX_MESSAGE_BRANCH_DEPTH,
      }).success,
    ).toBe(true);
  });

  it('caps the message tree at depth 4 (ADR-0039)', () => {
    expect(MAX_MESSAGE_BRANCH_DEPTH).toBe(4);
    expect(
      messageThreadBindingSchema.safeParse({
        thread_id: 'thread-01',
        parent_message_id: 'msg-01',
        branch_depth: 5,
      }).success,
    ).toBe(false);
  });

  it('rejects a branched depth without a parent', () => {
    expect(
      messageThreadBindingSchema.safeParse({
        thread_id: 'thread-01',
        parent_message_id: null,
        branch_depth: 2,
      }).success,
    ).toBe(false);
  });

  it('rejects a parent at depth 0', () => {
    expect(
      messageThreadBindingSchema.safeParse({
        thread_id: 'thread-01',
        parent_message_id: 'msg-01',
        branch_depth: 0,
      }).success,
    ).toBe(false);
  });
});

describe('channelSendReceipt', () => {
  it('accepts a journaled provider receipt', () => {
    expect(
      channelSendReceiptSchema.safeParse({ message_id: 'tg-100', sent_at: 1_700_000_000_000 })
        .success,
    ).toBe(true);
  });

  it('rejects an empty message_id', () => {
    expect(channelSendReceiptSchema.safeParse({ message_id: '', sent_at: 0 }).success).toBe(false);
  });
});

describe('inbound gates', () => {
  it('is exactly the five gates, in contract order', () => {
    expect(inboundGateSchema.options).toEqual([
      'transport',
      'shape',
      'identity',
      'budget',
      'replica',
    ]);
  });

  it('drop gates are exactly the gates behind transport (401 is an error, not a drop)', () => {
    expect(['transport', ...inboundDecisionSchema.options[1].shape.gate.options]).toEqual(
      inboundGateSchema.options,
    );
  });

  it('accepts an accepted decision keyed by update_id and a dropped decision', () => {
    expect(
      inboundDecisionSchema.safeParse({ outcome: 'accepted', update_id: 7 }).success,
    ).toBe(true);
    expect(inboundDecisionSchema.safeParse({ outcome: 'dropped', gate: 'shape' }).success).toBe(
      true,
    );
  });

  it("rejects a dropped decision blaming 'transport'", () => {
    expect(
      inboundDecisionSchema.safeParse({ outcome: 'dropped', gate: 'transport' }).success,
    ).toBe(false);
  });

  it('rejects an unknown outcome', () => {
    expect(inboundDecisionSchema.safeParse({ outcome: 'deferred', gate: 'shape' }).success).toBe(
      false,
    );
  });
});

const baseTgMessage = {
  update_id: 1,
  message: {
    from: { id: 42, is_bot: false },
    chat: { id: 42, type: 'private' },
    text: '/start',
  },
} as const;

describe('telegram gate-2 shapes', () => {
  it('update-type allowlist is exactly message, callback_query, my_chat_member', () => {
    expect(telegramUpdateTypeSchema.options).toEqual([
      'message',
      'callback_query',
      'my_chat_member',
    ]);
  });

  it('the inbound union mirrors the allowlist 1:1 (single owner)', () => {
    expect(
      telegramInboundUpdateSchema.options.map(
        (branch) => Object.keys(branch.shape).find((k) => k !== 'update_id'),
      ),
    ).toEqual(telegramUpdateTypeSchema.options);
  });

  it('accepts a private-chat text message', () => {
    expect(telegramMessageUpdateSchema.safeParse(baseTgMessage).success).toBe(true);
  });

  it('rejects a forwarded message (forward_origin is an unrecognized key)', () => {
    expect(
      telegramMessageUpdateSchema.safeParse({
        ...baseTgMessage,
        message: { ...baseTgMessage.message, forward_origin: { type: 'user' } },
      }).success,
    ).toBe(false);
  });

  it('rejects a bot sender', () => {
    expect(
      telegramMessageUpdateSchema.safeParse({
        ...baseTgMessage,
        message: { ...baseTgMessage.message, from: { id: 42, is_bot: true } },
      }).success,
    ).toBe(false);
  });

  it('rejects a non-private chat', () => {
    expect(
      telegramMessageUpdateSchema.safeParse({
        ...baseTgMessage,
        message: { ...baseTgMessage.message, chat: { id: -9, type: 'group' } },
      }).success,
    ).toBe(false);
  });

  it('rejects a media-only message (no text)', () => {
    const { text: _text, ...noText } = baseTgMessage.message;
    expect(
      telegramMessageUpdateSchema.safeParse({ update_id: 1, message: noText }).success,
    ).toBe(false);
  });

  it('rejects text over the length bound', () => {
    expect(
      telegramMessageUpdateSchema.safeParse({
        ...baseTgMessage,
        message: { ...baseTgMessage.message, text: 'x'.repeat(4097) },
      }).success,
    ).toBe(false);
  });

  it('checks the callback private chat under callback_query.message.chat (no top-level chat)', () => {
    const callback = (chatType: string) => ({
      update_id: 2,
      callback_query: {
        id: 'cb-1',
        from: { id: 42, is_bot: false },
        message: { chat: { id: 42, type: chatType } },
        data: 'proposal-01',
      },
    });
    expect(telegramCallbackQueryUpdateSchema.safeParse(callback('private')).success).toBe(true);
    expect(telegramCallbackQueryUpdateSchema.safeParse(callback('group')).success).toBe(false);
  });

  it('accepts my_chat_member from a group (leaveChat path) and a private kick (suppression)', () => {
    const member = (chatType: string, status: string) => ({
      update_id: 3,
      my_chat_member: {
        chat: { id: 42, type: chatType },
        from: { id: 42, is_bot: false },
        new_chat_member: { status },
      },
    });
    expect(telegramMyChatMemberUpdateSchema.safeParse(member('group', 'administrator')).success).toBe(
      true,
    );
    expect(telegramMyChatMemberUpdateSchema.safeParse(member('private', 'kicked')).success).toBe(
      true,
    );
    expect(telegramMyChatMemberUpdateSchema.safeParse(member('private', 'restricted')).success).toBe(
      false,
    );
  });

  it('rejects an allowlist-outside update type (edited_message)', () => {
    expect(
      telegramInboundUpdateSchema.safeParse({
        update_id: 4,
        edited_message: baseTgMessage.message,
      }).success,
    ).toBe(false);
  });
});

describe('link token', () => {
  it("kind is the literal 'telegram_link' and the TTL is 10 minutes", () => {
    expect(linkTokenKindSchema.parse('telegram_link')).toBe('telegram_link');
    expect(LINK_TOKEN_TTL_MIN).toBe(10);
  });

  it('accepts exactly 64 lower-hex chars', () => {
    expect(linkTokenSchema.safeParse(key).success).toBe(true);
  });

  it('rejects a short token', () => {
    expect(linkTokenSchema.safeParse('a'.repeat(63)).success).toBe(false);
  });

  it('rejects an upper-hex token (single canonical form for the digest match)', () => {
    expect(linkTokenSchema.safeParse('A'.repeat(64)).success).toBe(false);
  });
});

describe('bindResult', () => {
  it('codes are exactly the seven ADR-0067 consume outcomes, in table order', () => {
    expect(bindResultCodeSchema.options).toEqual([
      'bound',
      'already_used_self',
      'already_used_other',
      'expired',
      'invalid',
      'rebind_required',
      'peer_already_bound',
    ]);
  });

  it("rejects an eighth code ('token_reused')", () => {
    expect(bindResultCodeSchema.safeParse('token_reused').success).toBe(false);
  });

  it('the success/failure split partitions the seven codes exactly', () => {
    expect([
      ...bindResultSchema.options[0].shape.code.options,
      ...bindResultSchema.options[1].shape.code.options,
    ]).toEqual(bindResultCodeSchema.options);
  });

  it('accepts a bound result carrying user_id + binding_version', () => {
    expect(
      bindResultSchema.safeParse({ code: 'bound', user_id: 'user-01', binding_version: 1 }).success,
    ).toBe(true);
  });

  it('accepts a bare failure code', () => {
    expect(bindResultSchema.safeParse({ code: 'expired' }).success).toBe(true);
  });

  it('rejects a failure carrying identity (the chat is no oracle)', () => {
    expect(
      bindResultSchema.safeParse({ code: 'already_used_other', user_id: 'user-01' }).success,
    ).toBe(false);
  });

  it('rejects a success missing binding_version (the confirm key derives from it)', () => {
    expect(bindResultSchema.safeParse({ code: 'bound', user_id: 'user-01' }).success).toBe(false);
  });
});

describe('resolve / unbind', () => {
  it('resolve yields a versioned binding or null', () => {
    expect(resolveResultSchema.safeParse({ user_id: 'user-01', binding_version: 3 }).success).toBe(
      true,
    );
    expect(resolveResultSchema.safeParse(null).success).toBe(true);
  });

  it('rejects a non-positive binding_version', () => {
    expect(resolveResultSchema.safeParse({ user_id: 'user-01', binding_version: 0 }).success).toBe(
      false,
    );
  });

  it('unbind reasons are exactly the capability-ceiling dichotomy, in order', () => {
    expect(unbindReasonSchema.options).toEqual(['app_initiated', 'peer_revoked']);
  });

  it('unbind returns the retained fence version and nothing else', () => {
    expect(unbindResultSchema.safeParse({ binding_version: 3 }).success).toBe(true);
    expect(unbindResultSchema.safeParse({ binding_version: 3, chat_id: '42' }).success).toBe(false);
  });
});

const baseBinding = {
  channel: 'telegram',
  peer_id: '42',
  chat_id: '42',
  handle: 'someone',
  binding_version: 2,
  bound_at: 1_700_000_000_000,
  state: 'bound',
} as const;

describe('channelBinding', () => {
  it('carries exactly the ADR-0067 replica columns', () => {
    expect(Object.keys(channelBindingSchema.shape)).toEqual([
      'channel',
      'peer_id',
      'chat_id',
      'handle',
      'binding_version',
      'bound_at',
      'state',
    ]);
  });

  it("states are exactly bound, suppressed_blocked, unbound — 'active' is drift", () => {
    expect(channelBindingStateSchema.options).toEqual(['bound', 'suppressed_blocked', 'unbound']);
    expect(channelBindingStateSchema.safeParse('active').success).toBe(false);
  });

  it('accepts a bound row and a suppressed_blocked row (addressing intact, sends stopped)', () => {
    expect(channelBindingSchema.safeParse(baseBinding).success).toBe(true);
    expect(
      channelBindingSchema.safeParse({ ...baseBinding, state: 'suppressed_blocked' }).success,
    ).toBe(true);
  });

  it('accepts a tombstone: addressing scrubbed, version fence retained', () => {
    expect(
      channelBindingSchema.safeParse({
        ...baseBinding,
        state: 'unbound',
        peer_id: null,
        chat_id: null,
        handle: null,
      }).success,
    ).toBe(true);
  });

  it('rejects a tombstone that retains addressing (scrub law)', () => {
    expect(
      channelBindingSchema.safeParse({
        ...baseBinding,
        state: 'unbound',
        peer_id: null,
        handle: null,
      }).success,
    ).toBe(false);
  });

  it('rejects a bound row with scrubbed addressing', () => {
    expect(channelBindingSchema.safeParse({ ...baseBinding, peer_id: null }).success).toBe(false);
  });

  it('accepts a bound row without a handle (display-only, may be absent)', () => {
    expect(channelBindingSchema.safeParse({ ...baseBinding, handle: null }).success).toBe(true);
  });
});

describe('INBOUND_LIMITS', () => {
  it('parses and equals the ADR-0067 table verbatim', () => {
    expect(inboundLimitsSchema.safeParse(INBOUND_LIMITS).success).toBe(true);
    expect(INBOUND_LIMITS).toEqual({
      live_link_tokens_per_user: 1,
      token_mints_per_day: 5,
      invalid_start_per_hour: 5,
      invalid_start_mute_hours: 24,
      bound_inbound_per_min: 10,
      bound_inbound_per_day: 200,
      over_limit_notices_per_hour: 1,
      unknown_sender_replies_per_day: 1,
      unknown_sender_global_circuit_per_day: 100,
    });
  });

  it('rejects a zeroed limit (every limit is a positive int)', () => {
    expect(
      inboundLimitsSchema.safeParse({ ...INBOUND_LIMITS, bound_inbound_per_day: 0 }).success,
    ).toBe(false);
  });
});

describe('gate counters + constants', () => {
  it('counter names are exactly the three ADR-0067 counters, in order', () => {
    expect(gateCounterSchema.options).toEqual(['gate1_reject', 'tg_token_replay', 'tg_unknown_drop']);
  });

  it('pins the gate-1 header and the bind-confirm key salt', () => {
    expect(TELEGRAM_WEBHOOK_SECRET_HEADER).toBe('X-Telegram-Bot-Api-Secret-Token');
    expect(TG_BIND_CONFIRM_KIND).toBe('tg_bind_confirm');
  });
});

describe('cross-module: account-event class at this seam', () => {
  it('the bind/rebind/unlink notice this seam emits is system-emitted, never agent-invocable', () => {
    // Keeps the delivery invariant (every agent-reachable exempt class carries a non-null
    // daily cap) satisfied vacuously for the budget-exempt account_event class.
    const notice = {
      push_class: 'account_event',
      event: 'bind',
      binding_version: 2,
      agent_invocable: false,
    } as const;
    expect(accountEventNoticeSchema.safeParse(notice).success).toBe(true);
    expect(
      accountEventNoticeSchema.safeParse({ ...notice, agent_invocable: true }).success,
    ).toBe(false);
  });
});

describe('channelPeer', () => {
  it('accepts channel-namespaced addressing with an optional handle', () => {
    expect(
      channelPeerSchema.safeParse({ peer_id: '42', chat_id: '42', handle: null }).success,
    ).toBe(true);
  });

  it('rejects an empty peer_id', () => {
    expect(
      channelPeerSchema.safeParse({ peer_id: '', chat_id: '42', handle: null }).success,
    ).toBe(false);
  });
});
