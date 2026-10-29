import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DayCardsView, DayCardView } from './DayCards';
import { readControls, type DayRecord } from './controls-model';
import type { AppDay, CardLatest } from './day-cards-model';

type Card = DayRecord['data']['cards'][number];
const brief = (over: Partial<Card> = {}): Card => ({ id: 'card:brief', name: 'The Brief', defaultTime: '08:00', time: '08:00', reason: 'planned', sent: false, pin: null, ...over });
const midday = (over: Partial<Card> = {}): Card => ({ id: 'card:midday', name: 'Check-in', defaultTime: '14:00', time: null, reason: 'planned', sent: false, pin: null, ...over });
const close = (over: Partial<Card> = {}): Card => ({ id: 'card:close', name: 'The Close', defaultTime: '21:30', time: null, reason: 'planned', sent: false, pin: null, ...over });
const reason = 'Waldo couldn’t reach its model this morning';
const letter = (over: Partial<CardLatest> = {}): CardLatest => ({ message_id: 'row-1', delivered_at: Date.UTC(2026, 9, 28, 8, 2), excerpt: 'Morning. Your day opens with the design review at ten.\nLunch with Ana at one.', ...over });
// Noon in the owner's zone (UTC here): the Brief's time has passed, Check-in's and the Close's are still to come.
const NOON = Date.UTC(2026, 9, 28, 12, 0);
const view = (props: Partial<Parameters<typeof DayCardView>[0]> & { card: Card }) => renderToStaticMarkup(<DayCardView zone="UTC" now={NOON} busy={false} onRetry={() => {}} {...props}/>);
const app = (entries: [string, CardLatest | null][], dailyBrief: boolean | null = true): AppDay => ({ latest: new Map(entries), dailyBrief });

describe('today\'s cards on the console, stacked as the app\'s Home lists them', () => {
  it('stacks the Brief, Check-in and the Close in the order of the day, each under its name and time', () => {
    const html = renderToStaticMarkup(<DayCardsView cards={[close(), brief(), midday()]} app={app([])} zone="UTC" now={NOON} play={() => false} busy={false} onRetry={() => {}}/>);
    const names = [...html.matchAll(/<span class="strong">([^<]+)<\/span><span class="meta">([^<]+)<\/span>/g)].map(match => `${match[1]} ${match[2]}`);
    expect(names).toEqual(['The Brief 8:00 AM', 'Check-in 2:00 PM', 'The Close 9:30 PM']);
  });

  it('shows each card\'s words where it went out, and plays only the ones this browser has not seen', () => {
    const cards = [brief({ sent: true, state: 'sent' }), midday({ sent: true, state: 'sent' }), close()];
    const html = renderToStaticMarkup(<DayCardsView cards={cards} app={app([['card:brief', letter()], ['card:midday', letter({ message_id: 'row-2', excerpt: 'Afternoon is clear until four.' })], ['card:close', null]])}
      zone="UTC" now={NOON} play={id => id === 'row-2'} busy={false} onRetry={() => {}}/>);
    expect(html).toContain('aria-label="Morning. Your day opens with the design review at ten. Lunch with Ana at one."');
    expect(html).toContain('aria-label="Afternoon is clear until four."');
    expect(html.match(/class="card-word"/g)).toHaveLength(5);
    expect(html).toContain('<span class="card-word" aria-hidden="true" style="--at:0ms">Afternoon</span>');
    expect(html).toContain('Not yet. It comes at 9:30 PM.');
  });

  it('offers Try again on the card that failed, and only there', () => {
    const cards = [midday(), brief({ state: 'failed', state_reason: reason, retries_left: 2 })];
    const rows = renderToStaticMarkup(<DayCardsView cards={cards} app={null} zone="UTC" now={NOON} play={() => false} busy={false} onRetry={() => {}}/>).split('<li').slice(1);
    expect(rows.map(row => row.includes('>Try again<'))).toEqual([true, false]);
    expect(rows[0]).toContain('The Brief');
  });
});

describe('one card, every state', () => {
  it('shows what went out, whole, with when it arrived', () => {
    const html = view({ card: brief({ sent: true, state: 'sent' }), latest: letter() });
    expect(html).toContain('aria-label="Morning. Your day opens with the design review at ten. Lunch with Ana at one."');
    expect(html).toContain('Arrived 8:02 AM');
    expect(html).not.toContain('card-word');
    expect(html).not.toContain('Read it all in Chat');
  });

  it('plays a new message in word by word, the words hidden from screen readers and timed at the app\'s pace', () => {
    const html = view({ card: brief({ sent: true, state: 'sent' }), latest: letter(), play: true });
    expect(html).toMatch(/<span class="card-word" aria-hidden="true" style="--at:0ms">Morning\.<\/span>/);
    expect(html).toContain('style="--at:330ms">Your</span>');
  });

  it('cuts a long message at a whole word and sends the rest to Chat', () => {
    const html = view({ card: midday({ sent: true, state: 'sent' }), latest: letter({ excerpt: `${'plan '.repeat(56)}`.slice(0, 280) }) });
    expect(html).toContain('plan…');
    expect(html).toMatch(/<a[^>]*href="#\/chat"[^>]*>Read it all in Chat<\/a>/);
  });

  it('says a card went out when its words can\'t be read, and when it went somewhere other than Chat', () => {
    expect(view({ card: midday({ sent: true, state: 'sent' }) })).toContain('Check-in went out. <a href="#/chat">Read it in Chat.</a>');
    expect(view({ card: close({ sent: true, state: 'sent' }), latest: null })).toContain('The Close went out somewhere other than Chat, so it isn’t shown here.');
  });

  it('says Waldo is making it while the model works on it', () => {
    expect(view({ card: midday({ state: 'generating', state_reason: 'Waldo is making it now', retries_left: 2 }) })).toBe('<p>Waldo is making Check-in now.</p>');
    expect(view({ card: brief({ state: 'generating' }) })).toContain('Waldo is making the Brief now.');
  });

  it('says why Waldo couldn\'t make it, with Try again only while tries are left', () => {
    const html = view({ card: brief({ state: 'failed', state_reason: reason, retries_left: 2 }) });
    expect(html).toContain('Waldo couldn’t make the Brief.');
    expect(html).toContain(reason);
    expect(html).toContain('>Try again<');
    expect(html).toContain('2 tries left today');
    expect(view({ card: close({ state: 'failed', state_reason: reason, retries_left: 0 }) })).not.toContain('Try again');
    expect(view({ card: midday({ state: 'paused', state_reason: 'Paused after 3 failed tries in a row', retries_left: 3 }) })).toContain('Try again');
    expect(view({ card: brief({ state: 'failed', state_reason: reason, retries_left: 1 }), busy: true })).toMatch(/<button[^>]*disabled/);
  });

  it('says a skip, with its reason and no Try again, or plainly when the model chose it', () => {
    const html = view({ card: brief({ sent: true, state: 'skipped', state_reason: reason }) });
    expect(html).toContain('Waldo couldn’t make the Brief.');
    expect(html).not.toContain('Try again');
    expect(view({ card: midday({ sent: true, state: 'skipped' }), latest: null })).toContain('Waldo skipped Check-in today.');
  });

  it('says when it comes, that it is due and not out yet, held for quiet hours, or off with the daily brief', () => {
    expect(view({ card: close(), latest: null })).toContain('Not yet. It comes at 9:30 PM.');
    expect(view({ card: brief({ state: 'pending' }), latest: null })).toContain('Due at 8:00 AM, not out yet.');
    expect(view({ card: midday({ state: 'held' }), latest: null })).toContain('Check-in is held for your quiet hours.');
    expect(view({ card: close(), latest: null, dailyBrief: false })).toContain('Not today: the daily brief is off.');
  });

  it('reads the controls=3 card fields and refuses malformed ones', () => {
    const record = (card: object) => ({ version: 1, view: 'day', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64),
      data: { timezone: 'UTC', date: '2026-10-27', cards: [card], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' } } });
    expect(readControls(record(brief({ state: 'failed', state_reason: reason, retries_left: 3 })), 'day').data.cards[0]).toMatchObject({ state: 'failed', state_reason: reason, retries_left: 3 });
    for (const invalid of [{ state: 'ready' }, { state_reason: 7 }, { retries_left: 4 }, { retries_left: 1.5 }])
      expect(() => readControls(record(brief(invalid as Partial<Card>)), 'day')).toThrow();
  });
});
