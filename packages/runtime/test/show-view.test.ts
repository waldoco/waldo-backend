import { describe, expect, it } from 'vitest';
import { buildSessionState, handlerAllowlistMatchesAcl, VIEW_MAX_PER_REPLY, viewFallbackText, type ConversationEntry, type ViewInput } from '@waldo/contracts';
import { appMessageV1Schema } from '../../contracts/src/app/core';
import { appTranscriptPage } from '../src/channels/app-api';
import { dispatchTool } from '../src/tools/dispatcher';
import { replyWithViews, showViewHandler, turnViews } from '../src/tools/live/show-view';
import { sanitise } from '../src/scribe/sanitiser';

const hotels: ViewInput = {
  kind: 'options', title: 'Goa, 12 to 15 Dec',
  items: [
    { title: 'Taj Holiday Village', facts: [{ label: 'Per night', value: '₹14,500' }], link: 'https://example.com/taj', pick: true },
    { title: 'Ahilya by the Sea', facts: [{ label: 'Per night', value: '₹11,000' }] },
  ],
};
const plan: ViewInput = { kind: 'steps', items: [{ title: 'Book flights', state: 'done' }, { title: 'Pick a hotel', state: 'current' }] };
const call = (seq: number, view: unknown, ok = true) => ({ seq, call: { name: 'show_view', args: { view } }, ok });

const dispatch = (args: unknown) => dispatchTool({ id: crypto.randomUUID(), name: 'show_view', args }, {
  authenticatedUserId: 'synthetic-owner', trigger: 'user_message',
  session: buildSessionState({ trigger: 'user_message', canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1_700_000_000_000 }),
  now: () => 1_700_000_000_000, rateLimitCheck: () => true, hasApproval: () => true,
  sourceTaint: null, toolArgSourceTaint: null, sanitise,
}, { handlers: [showViewHandler()] });

describe('show_view', () => {
  it('is an owner-chat tool whose allowlist matches its ACL', () => {
    const handler = showViewHandler();
    expect(handler.trigger_allowlist).toEqual(['user_message']);
    expect(handlerAllowlistMatchesAcl('show_view', handler.trigger_allowlist)).toBe(true);
  });

  it('accepts an oversized view and says how much did not fit, and refuses one that is not a view', async () => {
    const long = { kind: 'timeline', items: Array.from({ length: 30 }, (_, i) => ({ when: `${i}:00`, title: `Slot ${i}` })) };
    expect(await dispatch({ view: long })).toMatchObject({ ok: true, data: { shown: true, left_out: 6 } });
    expect(await dispatch({ view: { kind: 'html', html: '<script>x</script>' } })).toMatchObject({ ok: false });
    expect(await dispatch({ view: hotels, also: 'x' })).toMatchObject({ ok: false });
  });

  it('reads a turn\'s views back from its successful calls only, in call order', () => {
    const views = turnViews([call(1, hotels), call(2, plan, false), { seq: 3, call: { name: 'web_search', args: {} }, ok: true }, call(4, { kind: 'nope' }), call(5, plan)]);
    expect(views.map(view => view.kind)).toEqual(['options', 'steps']);
  });

  it('shows the first views of a reply up to the count the tool states', () => {
    expect(showViewHandler().description).toContain(`up to ${VIEW_MAX_PER_REPLY} per reply`);
    const views = turnViews(Array.from({ length: VIEW_MAX_PER_REPLY + 2 }, (_, i) => call(i + 1, { kind: 'steps', items: [{ title: `Plan ${i}` }] })));
    expect(views.map(view => view.kind === 'steps' && view.items[0]!.title)).toEqual(Array.from({ length: VIEW_MAX_PER_REPLY }, (_, i) => `Plan ${i}`));
  });

  it('stores the views as text after the reply, and serves them as parts while the text stays what older builds show', () => {
    const views = turnViews([call(1, hotels), call(2, plan)]);
    const receipt = { line: 'Done: reminder set', items: [{ kind: 'reminder_set', target: null, outcome: 'accepted' as const, via_task: false, at: 1_790_000_000_000, digest: null }], more: 0 };
    const stored = `${replyWithViews('Two that fit your dates.', views)}\n\n${receipt.line}`;
    expect(stored).toBe(['Two that fit your dates.', viewFallbackText(views[0]!), viewFallbackText(views[1]!), receipt.line].join('\n\n'));
    const entry: ConversationEntry = { id: 'r1', ownerId: 'o', chatId: 'c', parentId: null, threadAnchorId: null, surface: 'app', modelPayload: 'Two that fit your dates.',
      appPayload: stored, modelProjection: { mode: 'include' }, role: 'assistant', receipt, views };
    const message = appTranscriptPage([entry], null, 5).messages[0]!;
    expect(appMessageV1Schema.parse(message)).toEqual(message);
    expect(message.text).toBe(stored);
    expect(message.parts.map(part => part.type)).toEqual(['text', 'view', 'view', 'receipt']);
    expect(message.parts.filter(part => part.type === 'view').map(part => part.fallback_text)).toEqual(views.map(viewFallbackText));
    expect(replyWithViews('', views)).toBe(views.map(viewFallbackText).join('\n\n'));
  });

  it('serves a row with no views exactly as before', () => {
    const entry: ConversationEntry = { id: 'r2', ownerId: 'o', chatId: 'c', parentId: null, threadAnchorId: null, surface: 'app', modelPayload: 'Hi', appPayload: 'Hi', modelProjection: { mode: 'include' }, role: 'assistant' };
    expect(appTranscriptPage([entry], null, 5).messages[0]!.parts).toEqual([{ type: 'text', text: 'Hi' }]);
  });
});
