import { describe, expect, it } from 'vitest';
import { redactConversationEntry, type ConversationEntry } from '@waldo/contracts';
import { appHistoryResultV1Schema } from '../../contracts/src/app/core';
import { appTranscriptPage } from '../src/channels/app-api';
import { appCaller, appQuickRepliesPart, type AppSend } from '../src/channels/surfaces/app';
import { APP_REPLIES } from '../src/channels/delivery-routes';
import { FORGOTTEN } from '../src/memory/claims';
import { DAY_CARDS, PLANNING_BRIEF_INSTRUCTION, dayCardPrompt } from '../src/prompt/day-cards';
import { cardReplyBook, offerRepliesHandler } from '../src/tools/live/offer-replies';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

const ctx = (turnId?: string) => ({ ...(turnId ? { turnId } : {}) }) as unknown as ToolDispatcherContext;

describe('the answers a planning card offers', () => {
  it('are kept only for the card being written, once, and taken with it', async () => {
    const book = cardReplyBook();
    const tool = offerRepliesHandler(book.port);
    expect(await tool.eligible!()).toMatchObject({ ok: false });
    expect(await tool.handle({ choices: ['Deck'] }, ctx('card:brief:1'))).toMatchObject({ ok: true, data: { offered: false, reason: 'not_card_turn' } });

    book.open('card:brief:1');
    expect(await tool.eligible!()).toEqual({ ok: true });
    // Another turn running beside the card (an owner message) cannot put answers on it.
    expect(await tool.handle({ choices: ['Deck'] }, ctx('owner-turn'))).toMatchObject({ ok: true, data: { offered: false, reason: 'not_card_turn' } });
    expect(await tool.handle({ choices: ['Deck'] }, ctx())).toMatchObject({ ok: true, data: { offered: false, reason: 'not_card_turn' } });
    expect(await tool.handle({ choices: ['Deck', 'Gym first'] }, ctx('card:brief:1'))).toMatchObject({ ok: true, data: { offered: true } });
    expect(await tool.handle({ choices: ['Something else'] }, ctx('card:brief:1'))).toMatchObject({ ok: true, data: { offered: false, reason: 'already_offered' } });

    expect(book.take('card:brief:1')).toEqual(['Deck', 'Gym first']);
    expect(await tool.eligible!()).toMatchObject({ ok: false });
    expect(book.take('card:brief:1')).toEqual([]);
  });

  it('a card that offered nothing takes nothing and closes its slot', async () => {
    const book = cardReplyBook();
    book.open('card:brief:2');
    expect(book.take('card:brief:2')).toEqual([]);
    expect(book.port.open()).toBe(false);
  });
});

describe('the answers on the app row', () => {
  const row = (extra: Partial<ConversationEntry> = {}): ConversationEntry => ({ id: 'scheduled-1', ownerId: 'o', chatId: 'c', parentId: null, threadAnchorId: null, surface: 'app',
    modelPayload: 'The Brief\nWhat do you want done today?', appPayload: 'The Brief\nWhat do you want done today?', modelProjection: { mode: 'include' }, role: 'assistant', ...extra });

  it('show as a quick_replies part the app contract accepts, after the text, with the question still in the text', () => {
    const page = appTranscriptPage([row({ quickReplies: ['Finish the deck', 'Gym first', 'Something else'] })], null, 5);
    const parsed = appHistoryResultV1Schema.parse(page);
    expect(parsed.messages[0]!.parts).toEqual([
      { type: 'text', text: 'The Brief\nWhat do you want done today?' },
      { type: 'quick_replies', choices: [{ id: 'r1', label: 'Finish the deck' }, { id: 'r2', label: 'Gym first' }, { id: 'r3', label: 'Something else' }], fallback_text: 'Finish the deck / Gym first / Something else' },
    ]);
    // A build that predates the part shows the text alone, which carries the question.
    expect(parsed.messages[0]!.text).toBe(row().appPayload);
    expect(appTranscriptPage([row()], null, 5).messages[0]!.parts).toEqual([{ type: 'text', text: row().appPayload }]);
  });

  it('are forgotten with the row, and a label a forget made too long drops the part, never the text', () => {
    const forgotten = redactConversationEntry(row({ quickReplies: ['Call Priya', 'Priya Sharma lunch'] }), text => text.replaceAll('Priya', FORGOTTEN));
    expect(forgotten.quickReplies).toEqual([`Call ${FORGOTTEN}`, `${FORGOTTEN} Sharma lunch`]);
    expect(JSON.stringify(forgotten)).not.toContain('Priya');
    expect(appQuickRepliesPart(forgotten.quickReplies!)).toBeNull();
    expect(appTranscriptPage([forgotten], null, 5).messages[0]!.parts).toEqual([{ type: 'text', text: row().appPayload }]);
    expect(redactConversationEntry(row(), text => text)).not.toHaveProperty('quickReplies');
  });

  it('reach the scheduled delivery only from the send that names them', async () => {
    const sends: (AppSend | undefined)[] = [];
    const call = appCaller(() => async (_text, send) => { sends.push(send); return 'row-1'; });
    await call('sendMessage', { chat_id: 1, text: 'Brief', [APP_REPLIES]: ['Deck', 'Gym first'] });
    await call('sendMessage', { chat_id: 1, text: 'Brief' });
    await call('sendMessage', { chat_id: 1, text: 'Brief', [APP_REPLIES]: [] });
    expect(sends).toEqual([{ nowOnly: false, replies: ['Deck', 'Gym first'] }, { nowOnly: false }, { nowOnly: false }]);
  });
});

describe('the planning Brief prompt', () => {
  const context = { calendar: 'No events.', ledger: '', today: '', updates: '' };
  it('changes only the Brief, and only its instruction and body rule', () => {
    for (const card of DAY_CARDS) {
      const off = dayCardPrompt(card, '2026-11-03T08:00', context), on = dayCardPrompt(card, '2026-11-03T08:00', context, true);
      if (card.id !== 'card:brief') { expect(on).toBe(off); continue; }
      expect(on).not.toBe(off);
      expect(on).toContain(PLANNING_BRIEF_INSTRUCTION);
      expect(on).not.toContain(card.instruction);
      expect(off).toContain(card.instruction);
      // The data sections and the format line are the same on both.
      expect(on.split('\n\n').slice(0, 4)).toEqual(off.split('\n\n').slice(0, 4));
      expect(on.split('\n\n').at(-1)).toBe(off.split('\n\n').at(-1));
    }
  });
});
