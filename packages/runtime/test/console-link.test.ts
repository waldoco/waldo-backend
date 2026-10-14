import { describe, expect, it, vi } from 'vitest';
import { handlerAllowlistMatchesAcl, sendConsoleLinkResultSchema, type SendConsoleLinkResult } from '@waldo/contracts';
import { consoleLinkHandler, type ConsoleLinkTurn } from '../src/tools/live/console-link';
import { consoleLinkSender, consoleLinkText, CREDENTIAL_REPLY_TEXT, maskCredentialReply, recordCredentialMessage, type ConsoleLinkRoute } from '../src/channels/console-link';
import { ClosedRunError } from '../src/channels/run-effect-scope';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';
import { TOOL_CLAIM_EFFECT } from '../src/hooks/claim-verify-effects';
import { TOOL_ARG_SCHEMAS } from '../src/hooks/registry';
import { TOOL_REPLAY_CLASS } from '../src/hooks/tool-replay-class';
import { CHILD_READ_TOOLS } from '../src/conversation/subagent';
import { SOURCE_SCOPE_CLASS } from '../src/tools/source-scope';

const LINK = 'https://waldo.invalid/console?t=c1.eyJvd25lciI6Im93bmVyLXN5bnRoZXRpYyJ9.' + 'a'.repeat(64);
const REQUEST = 'Can you send me my console link?';

// The context a real owner turn hands every tool call: owner-initiated, the owner's own words with no foreign span.
const ownerTurn = (over: Partial<Record<string, unknown>> = {}, current: Readonly<{ text: string; sourceQuoteRanges?: readonly Readonly<{ start: number; end: number }>[] }> = { text: REQUEST, sourceQuoteRanges: [] }) => ({
  trigger: 'user_message', authenticatedUserId: 'prn_owner', sourceTaint: null, toolArgSourceTaint: null, turnId: 'tg-41', ownerInitiated: true,
  session: {} as never, memoryTurn: { ownerId: 'prn_owner', conversationRef: 'telegram-42', current: { message_ref: 'tg-41', ...current }, recent: [] }, ...over,
}) as unknown as ToolDispatcherContext;

const sent = (surface: 'telegram' | 'imessage' = 'telegram'): SendConsoleLinkResult => ({ sent: true, surface });

describe('send_console_link handler: the deterministic owner-typed gate', () => {
  it('sends for the owner\'s own typed request and reports only the typed outcome', async () => {
    const send = vi.fn(async (_turn: ConsoleLinkTurn) => sent());
    const result = await consoleLinkHandler(send).handle({}, ownerTurn());
    expect(result).toEqual({ ok: true, data: { sent: true, surface: 'telegram' }, source_taint: null });
    expect(sendConsoleLinkResultSchema.safeParse(result.ok && result.data).success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].turnId).toBe('tg-41');
  });

  // Mutation table rows: each gate removed must turn one of these into a mint.
  it.each([
    ['a job or reminder turn (no owner turn behind it)', ownerTurn({ ownerInitiated: undefined })],
    ['a brief trigger', ownerTurn({ trigger: 'brief' })],
    ['a turn without an id', ownerTurn({ turnId: undefined })],
    ['no owner message in this turn', ownerTurn({ memoryTurn: undefined })],
    ['a forwarded message (every word someone else\'s)', ownerTurn({}, { text: `[Forwarded by the owner from someone else:]\n${JSON.stringify(REQUEST)}\n[End of forwarded text.]`, sourceQuoteRanges: [{ start: 0, end: 90 }] })],
    ['a quoted request beside the owner\'s own words', ownerTurn({}, { text: `See this\n${REQUEST}`, sourceQuoteRanges: [{ start: 9, end: 9 + REQUEST.length }] })],
    ['a media-only message (no typed words)', ownerTurn({}, { text: '   ', sourceQuoteRanges: [] })],
  ])('never mints for %s', async (_label, ctx) => {
    const send = vi.fn(async () => sent());
    expect(await consoleLinkHandler(send).handle({}, ctx)).toEqual({ ok: true, data: { sent: false, reason: 'not_owner_typed' }, source_taint: null });
    expect(send).not.toHaveBeenCalled();
  });

  it('never mints in a turn that carries outside content: a reply to someone else, or something read this turn', async () => {
    const send = vi.fn(async () => sent());
    expect(await consoleLinkHandler(send).handle({}, ownerTurn({ toolArgSourceTaint: 'external' }))).toEqual({ ok: true, data: { sent: false, reason: 'outside_content' }, source_taint: null });
    expect(send).not.toHaveBeenCalled();
  });

  it('turns a failed send into a typed reason and never throws its text to the turn', async () => {
    const result = await consoleLinkHandler(async () => { throw new Error(`telegram refused ${LINK}`); }).handle({}, ownerTurn());
    expect(result).toEqual({ ok: true, data: { sent: false, reason: 'send_failed' }, source_taint: null });
    expect(JSON.stringify(result)).not.toContain('console?t=');
  });

  it('lets a closed run stay closed', async () => {
    await expect(consoleLinkHandler(async () => { throw new ClosedRunError(); }).handle({}, ownerTurn())).rejects.toBeInstanceOf(ClosedRunError);
  });

  it('is a user_message tool with no arguments, matching its ACL', () => {
    const handler = consoleLinkHandler(async () => sent());
    expect(handler.name).toBe('send_console_link');
    expect(handlerAllowlistMatchesAcl(handler.name, handler.trigger_allowlist)).toBe(true);
    expect(handler.trigger_allowlist).toEqual(['user_message']);
    expect(handler.schema.safeParse({}).success).toBe(true);
    expect(handler.schema.safeParse({ chat_id: 7 }).success).toBe(false);
  });
});

describe('console link sender: one link per turn, minted only when it can be delivered', () => {
  const turn: ConsoleLinkTurn = { turnId: 'tg-41' };
  const telegramRoute = (deliver: (text: string) => Promise<boolean> = async () => true, already = false): ConsoleLinkRoute => ({ surface: 'telegram', sent: () => already, deliver });
  const sender = (route: ConsoleLinkRoute, mint: () => Promise<string | null> = async () => LINK, available = () => true) => {
    const logs: Record<string, unknown>[] = [];
    const deps = { surface: 'surface' in route ? route.surface : 'app', route, available, mint: vi.fn(mint), log: (entry: Record<string, unknown>) => { logs.push(entry); } };
    return { send: consoleLinkSender(deps), mint: deps.mint, logs };
  };

  it('delivers the link text once and logs only the outcome and surface', async () => {
    const deliver = vi.fn(async (_text: string) => true);
    const s = sender(telegramRoute(deliver));
    expect(await s.send(turn)).toEqual({ sent: true, surface: 'telegram' });
    expect(deliver).toHaveBeenCalledWith(consoleLinkText(LINK), turn);
    expect(s.logs).toEqual([{ trace: 'tg-41', hop: 'console_link', ms: expect.any(Number), ok: true, detail: 'telegram' }]);
    expect(JSON.stringify(s.logs)).not.toContain('console?t=');
    // A second call in the same turn would void the first link: nothing is minted.
    expect(await s.send(turn)).toEqual({ sent: false, reason: 'already_sent' });
    expect(s.mint).toHaveBeenCalledTimes(1);
    expect(await s.send({ turnId: 'tg-42' })).toEqual({ sent: true, surface: 'telegram' });
  });

  it('checks a durable earlier send before it mints', async () => {
    const s = sender(telegramRoute(async () => true, true));
    expect(await s.send(turn)).toEqual({ sent: false, reason: 'already_sent' });
    expect(s.mint).not.toHaveBeenCalled();
  });

  it.each([['app', 'app_unsupported'], ['whatsapp', 'surface_unsupported']] as const)('on %s mints nothing', async (_surface, reason) => {
    const s = sender({ unsupported: reason });
    expect(await s.send(turn)).toEqual({ sent: false, reason });
    expect(s.mint).not.toHaveBeenCalled();
  });

  it('mints nothing while the host cannot hand the link to the owner (a capture probe)', async () => {
    const s = sender(telegramRoute(), async () => LINK, () => false);
    expect(await s.send(turn)).toEqual({ sent: false, reason: 'unavailable' });
    expect(s.mint).not.toHaveBeenCalled();
  });

  it('says unavailable when console sign-in cannot mint, and send_failed when the send does not go', async () => {
    expect(await sender(telegramRoute(), async () => null).send(turn)).toEqual({ sent: false, reason: 'unavailable' });
    const failed = sender(telegramRoute(async () => false));
    expect(await failed.send(turn)).toEqual({ sent: false, reason: 'send_failed' });
    expect(failed.logs).toEqual([{ trace: 'tg-41', hop: 'console_link', ms: expect.any(Number), ok: false, detail: 'telegram' }]);
  });
});

describe('credential messages: a reply never carries a sent link back into a turn', () => {
  const kv = () => { const map = new Map<string, unknown>(); return { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); }, map }; };
  const update = (reply: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    update_id: 9, message: { message_id: 9, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, text: 'Is this still good?', reply_to_message: reply, ...extra },
  });
  const linkMessage = { message_id: 5, from: { id: 7, is_bot: true }, chat: { id: 42, type: 'private' }, date: 1, text: consoleLinkText(LINK), entities: [{ type: 'url', offset: 44, length: LINK.length }], link_preview_options: { url: LINK } };

  it('records a sent message by its chat and id, and ignores a send with no message', () => {
    const store = kv();
    expect(recordCredentialMessage(store, { message_id: 5, chat: { id: 42 } })).toBe(true);
    expect(recordCredentialMessage(store, undefined)).toBe(false);
    expect(recordCredentialMessage(store, { message_id: '5', chat: { id: 42 } })).toBe(false);
    expect(JSON.stringify([...store.map.values()])).toBe('[[{"chat":42,"message":5}]]');
  });

  it('masks every field of a reply to a recorded message, and its quote', () => {
    const store = kv();
    recordCredentialMessage(store, { message_id: 5, chat: { id: 42 } });
    const masked = maskCredentialReply(update(linkMessage, { quote: { text: LINK, position: 44 } }), store) as ReturnType<typeof update>;
    expect(JSON.stringify(masked)).not.toContain('console?t=');
    expect(masked.message.reply_to_message).toEqual({ message_id: 5, from: { id: 7, is_bot: true }, chat: { id: 42, type: 'private' }, date: 1, text: CREDENTIAL_REPLY_TEXT });
    expect(masked.message).not.toHaveProperty('quote');
    expect(masked.message.text).toBe('Is this still good?');
  });

  it('masks a caption reply as well as a text one', () => {
    const store = kv();
    recordCredentialMessage(store, { message_id: 5, chat: { id: 42 } });
    const { text: _text, entities: _entities, ...photo } = linkMessage;
    expect(JSON.stringify(maskCredentialReply(update({ ...photo, caption: consoleLinkText(LINK) }), store))).not.toContain('console?t=');
  });

  // Mutation table rows: a mask keyed on the wrong chat or id, or on text alone, fails one of these.
  it('leaves replies to any other message, chat or update shape untouched', () => {
    const store = kv();
    recordCredentialMessage(store, { message_id: 5, chat: { id: 42 } });
    const other = update({ ...linkMessage, message_id: 6, text: 'Ordinary reply text' });
    expect(maskCredentialReply(other, store)).toBe(other);
    const otherChat = update({ ...linkMessage, chat: { id: 43, type: 'private' } });
    expect(maskCredentialReply(otherChat, store)).toBe(otherChat);
    for (const value of [null, 'text', { update_id: 1 }, { message: { text: 'no reply' } }]) expect(maskCredentialReply(value, store)).toBe(value);
  });

  it('keeps a bounded record, newest last, so the oldest goes first', () => {
    const store = kv();
    for (let id = 1; id <= 300; id++) recordCredentialMessage(store, { message_id: id, chat: { id: 42 } });
    const rows = [...store.map.values()][0] as readonly Readonly<{ message: number }>[];
    expect(rows).toHaveLength(256);
    expect(rows.at(-1)!.message).toBe(300);
    const newest = maskCredentialReply(update({ ...linkMessage, message_id: 300 }), store) as ReturnType<typeof update>;
    expect(newest.message.reply_to_message.text).toBe(CREDENTIAL_REPLY_TEXT);
    const oldest = update({ ...linkMessage, message_id: 1 });
    expect(maskCredentialReply(oldest, store)).toBe(oldest);
  });
});

describe('send_console_link registry rows', () => {
  it('validates its empty arguments, claims no done effect, never runs in a child task and never auto-retries', () => {
    expect(TOOL_ARG_SCHEMAS.send_console_link?.safeParse({}).success).toBe(true);
    // A not-sent outcome is an ok result too, so a done label would claim a send that never happened.
    expect(TOOL_CLAIM_EFFECT.send_console_link).toBeNull();
    expect(TOOL_REPLAY_CLASS.send_console_link.replay).toBe('non_replayable_uncertain');
    expect(CHILD_READ_TOOLS).not.toContain('send_console_link');
    expect(SOURCE_SCOPE_CLASS.send_console_link).toBe('allow');
  });
});
