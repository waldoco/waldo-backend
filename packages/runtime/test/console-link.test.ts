import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { handlerAllowlistMatchesAcl, sendConsoleLinkResultSchema, type SendConsoleLinkResult } from '@waldo/contracts';
import { consoleLinkHandler, type ConsoleLinkTurn } from '../src/tools/live/console-link';
import { APP_CONSOLE_LINK_GONE, appConsoleLinks, appConsoleRoute, whatsappConsoleRoute, consoleLinkSender, consoleLinkText, CREDENTIAL_REPLY_TEXT, maskCredentialReply, recordCredentialMessage, type ConsoleLinkRoute } from '../src/channels/console-link';
import { appTranscriptPage } from '../src/channels/app-api';
import { SEND_NOW_ONLY } from '../src/channels/delivery-routes';
import { WHATSAPP_HELD } from '../src/channels/whatsapp-api';
import type { ConversationEntry } from '@waldo/contracts';
import { ClosedRunError, type RunEffectScope } from '../src/channels/run-effect-scope';
import { iMessageConsoleRoute } from '../src/channels/imessage/console-link';
import { IMessageFinalOutbox } from '../src/channels/imessage/final-outbox';
import type { IMessageInboxRecord } from '../src/channels/imessage/owner-inbox';
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

describe('iMessage console route: the link answers only the inbound message this run is executing', () => {
  const running = (attempt: string) => ({ id: 'imsg-1', updateId: 1, dedupKey: 'dedup-1', digest: 'digest-1', text: REQUEST, conversationRef: 'imessage-chain',
    binding: {} as IMessageInboxRecord['binding'], bindingDigest: 'binding-1', revision: '3', environment: 'test', bridgeDoName: 'bridge-1', ownerDoName: 'owner-1',
    commandId: 'wim_reply-1', occurredAt: 1, admittedAt: 1, state: 'running', attempt }) satisfies IMessageInboxRecord;
  const scope = (state: DurableObjectState, runId: string, attempt: string): RunEffectScope => ({
    runId, attempt, deadline: Date.now() + 60_000, signal: new AbortController().signal, admit: () => undefined, commit: work => state.storage.transactionSync(work),
  });
  const withRoute = (name: string, record: IMessageInboxRecord | null, run: (route: Extract<ConsoleLinkRoute, { surface: string }>, state: DurableObjectState) => Promise<void>) =>
    runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
      const route = iMessageConsoleRoute(state.storage, () => record);
      await run(route, state);
    });

  it('freezes one console record for the running message, on its bridge, under its own command id', async () => {
    await withRoute('console-route-current', running('attempt-1'), async (route, state) => {
      const turn = { turnId: 'imessage-1', runScope: scope(state, 'imsg-1', 'attempt-1') };
      expect(route.sent(turn)).toBe(false);
      expect(await route.deliver(consoleLinkText(LINK), turn)).toBe(true);
      expect(route.sent(turn)).toBe(true);
      const [row] = new IMessageFinalOutbox(state.storage).records();
      expect(row).toMatchObject({ replyRef: 'console:imsg-1', text: consoleLinkText(LINK), bridgeDoName: 'bridge-1', ownerDoName: 'owner-1', revision: '3', bindingDigest: 'binding-1', state: 'frozen' });
      expect(row!.commandId).toMatch(/^wcl_[a-f0-9]{40}$/);
    });
  });

  it.each([
    ['another inbound message', 'imsg-2', 'attempt-1'],
    ['an earlier attempt at this message', 'imsg-1', 'attempt-0'],
  ])('refuses a run scope for %s and freezes nothing', async (_label, runId, attempt) => {
    await withRoute(`console-route-${runId}-${attempt}`, running('attempt-1'), async (route, state) => {
      const turn = { turnId: 'imessage-1', runScope: scope(state, runId, attempt) };
      expect(() => route.sent(turn)).toThrow(ClosedRunError);
      await expect(route.deliver(consoleLinkText(LINK), turn)).rejects.toThrow(ClosedRunError);
      expect(new IMessageFinalOutbox(state.storage).records()).toEqual([]);
    });
  });

  it('refuses a turn with no run scope, or when no iMessage is running', async () => {
    await withRoute('console-route-unscoped', running('attempt-1'), async route => {
      await expect(route.deliver(consoleLinkText(LINK), { turnId: 'imessage-1' })).rejects.toThrow(ClosedRunError);
    });
    await withRoute('console-route-idle', null, async (route, state) => {
      await expect(route.deliver(consoleLinkText(LINK), { turnId: 'imessage-1', runScope: scope(state, 'imsg-1', 'attempt-1') })).rejects.toThrow(ClosedRunError);
      expect(new IMessageFinalOutbox(state.storage).records()).toEqual([]);
    });
  });
});

describe('WhatsApp console route: sent now or not at all', () => {
  const route = (answer: unknown) => {
    const bodies: object[] = [];
    const built = whatsappConsoleRoute(async (body) => { bodies.push(body); return answer; });
    return { built, bodies };
  };
  it('asks for a send that is never held and never previewed, and counts only an accepted send', async () => {
    const { built, bodies } = route({ messages: [{ id: 'wamid.out' }] });
    expect(await built.deliver(consoleLinkText(LINK), { turnId: 'wa-1' })).toBe(true);
    expect(bodies).toEqual([{ text: consoleLinkText(LINK), link_preview_options: { is_disabled: true }, [SEND_NOW_ONLY]: true }]);
    expect(built.sent({ turnId: 'wa-1' })).toBe(false);
  });
  it.each([['a closed window or a blocked send', undefined], ['a held send', WHATSAPP_HELD]])('reports %s as not delivered', async (_label, answer) => {
    expect(await route(answer).built.deliver(consoleLinkText(LINK), { turnId: 'wa-1' })).toBe(false);
  });
});

describe('app console route: the link shows under the reply to the message that asked, and nowhere the model reads', () => {
  const scope = (state: DurableObjectState, runId: string): RunEffectScope => ({
    runId, attempt: 'attempt-1', deadline: Date.now() + 60_000, signal: new AbortController().signal, admit: () => undefined, commit: work => state.storage.transactionSync(work),
  });
  const withKv = (name: string, run: (state: DurableObjectState) => Promise<void>) =>
    runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => run(state));
  const row = (id: string, role: 'user' | 'assistant', text: string, parentId: string | null, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({
    id, ownerId: 'prn_owner', chatId: 'app-main', parentId, threadAnchorId: null, surface: 'app', modelPayload: text, appPayload: text,
    modelProjection: { mode: 'include' }, role, ...(role === 'user' ? { inputOrigin: 'owner' as const } : {}), createdAt: 1, ...extra,
  });

  it('records the link for the running message once, and reads it back as sent', async () => {
    await withKv('app-console-route-once', async state => {
      const route = appConsoleRoute(state.storage.kv);
      const turn = { turnId: 'msg-1', runScope: scope(state, 'msg-1') };
      expect(route.sent(turn)).toBe(false);
      expect(await route.deliver(consoleLinkText(LINK), turn)).toBe(true);
      expect(route.sent(turn)).toBe(true);
      expect(route.sent({ turnId: 'msg-2', runScope: scope(state, 'msg-2') })).toBe(false);
      expect(appConsoleLinks(state.storage.kv)('msg-1')).toBe(consoleLinkText(LINK));
      expect(appConsoleLinks(state.storage.kv)('msg-2')).toBeNull();
      await expect(route.deliver(consoleLinkText(LINK), { turnId: 'msg-3' })).rejects.toThrow(ClosedRunError);
    });
  });

  it('shows an expired or replaced link as a fixed note, never the dead link', async () => {
    await withKv('app-console-route-expiry', async state => {
      let now = 1_000_000;
      const route = appConsoleRoute(state.storage.kv, () => now);
      await route.deliver(consoleLinkText(LINK), { turnId: 'msg-1', runScope: scope(state, 'msg-1') });
      await route.deliver(consoleLinkText(`${LINK}b`), { turnId: 'msg-2', runScope: scope(state, 'msg-2') });
      const links = () => appConsoleLinks(state.storage.kv, () => now);
      expect([links()('msg-1'), links()('msg-2')]).toEqual([APP_CONSOLE_LINK_GONE, consoleLinkText(`${LINK}b`)]);
      now += 10 * 60_000 + 1;
      expect(links()('msg-2')).toBe(APP_CONSOLE_LINK_GONE);
    });
  });

  it('adds the link to the newest reply to that message at read time, before its receipt line, and only there', () => {
    const receipt = { items: [], more: 0, line: 'Done: one thing.' } as unknown as NonNullable<ConversationEntry['receipt']>;
    const entries = [row('msg-1', 'user', REQUEST, null), row('msg-1-reply', 'assistant', 'It is below.\n\nDone: one thing.', 'msg-1', { receipt }), row('msg-2', 'user', 'Thanks', 'msg-1-reply'), row('msg-2-reply', 'assistant', 'Any time.', 'msg-2')];
    const page = appTranscriptPage(entries, null, 20, undefined, run => run === 'msg-1' ? consoleLinkText(LINK) : null);
    const reply = page.messages.find(message => message.id === 'msg-1-reply')!;
    expect(reply.text).toBe(`It is below.\n\n${consoleLinkText(LINK)}\n\nDone: one thing.`);
    expect(reply.parts[0]).toEqual({ type: 'text', text: reply.text });
    expect(page.messages.filter(message => message.text.includes('console?t='))).toHaveLength(1);
    expect(entries.map(entry => entry.appPayload).join('\n')).not.toContain('console?t=');
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
