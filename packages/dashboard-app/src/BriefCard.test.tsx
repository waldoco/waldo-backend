import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefCardView } from './BriefCard';
import type { BriefLatest } from './brief-model';
import { readControls, type DayRecord } from './controls-model';

type Card = DayRecord['data']['cards'][number];
const brief = (over: Partial<Card> = {}): Card => ({ id: 'card:brief', name: 'The Brief', defaultTime: '08:00', time: '08:00', reason: 'planned', sent: false, pin: null, ...over });
const reason = 'Waldo couldn’t reach its model this morning';

const letter = (over: Partial<BriefLatest> = {}): BriefLatest => ({ message_id: 'row-1', delivered_at: Date.UTC(2026, 9, 28, 8, 2), excerpt: 'Morning. Your day opens with the design review at ten.\nLunch with Ana at one.', ...over });
const view = (props: Partial<Parameters<typeof BriefCardView>[0]> & { card: Card }) => renderToStaticMarkup(<BriefCardView zone="UTC" busy={false} onRetry={() => {}} {...props}/>);

describe('the console Brief, as Home shows it', () => {
  it('shows the Brief that went out, whole, with when it arrived', () => {
    const html = view({ card: brief({ sent: true, state: 'sent' }), latest: letter() });
    expect(html).toContain('aria-label="Morning. Your day opens with the design review at ten. Lunch with Ana at one."');
    expect(html).toContain('Arrived 08:02');
    expect(html).not.toContain('brief-word');
    expect(html).not.toContain('Read it all in Chat');
  });

  it('plays a new Brief in word by word, the words hidden from screen readers and timed at the app\'s pace', () => {
    const html = view({ card: brief({ sent: true, state: 'sent' }), latest: letter(), play: true });
    expect(html).toMatch(/<span class="brief-word" aria-hidden="true" style="--at:0ms">Morning\.<\/span>/);
    expect(html).toContain('style="--at:330ms">Your</span>');
    expect(html).toContain('aria-label="Morning. Your day opens');
  });

  it('cuts a long Brief at a whole word and sends the rest to Chat', () => {
    const html = view({ card: brief({ sent: true, state: 'sent' }), latest: letter({ excerpt: `${'plan '.repeat(56)}`.slice(0, 280) }) });
    expect(html).toContain('plan…');
    expect(html).toMatch(/<a[^>]*href="#\/chat"[^>]*>Read it all in Chat<\/a>/);
  });

  it('says a Brief went out when this Worker cannot read its words, and when it went somewhere other than Chat', () => {
    expect(view({ card: brief({ sent: true, state: 'sent' }) })).toContain('Your Brief went out. Read it in Chat.');
    expect(view({ card: brief({ sent: true, state: 'sent' }), latest: null })).toContain('Your Brief went out somewhere other than Chat, so it isn’t shown here.');
  });

  it('says when the Brief comes, that it is held for quiet hours, or that Waldo skipped it, before it goes out', () => {
    expect(view({ card: brief({ state: 'pending', time: '07:30' }), latest: null })).toContain('No Brief yet today. It comes at 07:30.');
    expect(view({ card: brief({ state: 'held' }), latest: null })).toContain('Your Brief is held for your quiet hours.');
    expect(view({ card: brief({ sent: true, state: 'skipped' }), latest: null })).toContain('Waldo skipped today’s Brief.');
  });
});

describe('the console Brief card, from the same day view the app reads', () => {
  it('says the Brief could not be made, why, and offers Try again while tries are left', () => {
    const html = renderToStaticMarkup(<BriefCardView zone="UTC" card={brief({ state: 'failed', state_reason: reason, retries_left: 2 })} busy={false} onRetry={() => {}}/>);
    expect(html).toContain('Couldn’t make your Brief');
    expect(html).toContain(reason);
    expect(html).toContain('>Try again<');
    expect(html).toContain('2 tries left today');
    expect(renderToStaticMarkup(<BriefCardView zone="UTC" card={brief({ state: 'failed', state_reason: reason, retries_left: 0 })} busy={false} onRetry={() => {}}/>)).not.toContain('Try again');
  });

  it('names a paused card, one being made, and one that went out, with Try again only where it helps', () => {
    expect(renderToStaticMarkup(<BriefCardView zone="UTC" card={brief({ state: 'paused', state_reason: 'Paused after 3 failed tries in a row', retries_left: 3 })} busy={false} onRetry={() => {}}/>)).toContain('Try again');
    const making = renderToStaticMarkup(<BriefCardView zone="UTC" card={brief({ state: 'generating', state_reason: 'Waldo is making it now', retries_left: 2 })} busy={false} onRetry={() => {}}/>);
    expect(making).toContain('Making your Brief now');
    expect(making).not.toContain('Try again');
    expect(renderToStaticMarkup(<BriefCardView zone="UTC" card={brief({ sent: true, state: 'sent', retries_left: 3 })} busy={false} onRetry={() => {}}/>)).not.toContain('Try again');
  });

  it('says why a skipped Brief was skipped, with no Try again: the server gives a skipped card no tries', () => {
    const html = renderToStaticMarkup(<BriefCardView zone="UTC" card={brief({ sent: true, state: 'skipped', state_reason: reason })} busy={false} onRetry={() => {}}/>);
    expect(html).toContain('Couldn’t make your Brief');
    expect(html).toContain(reason);
    expect(html).not.toContain('Try again');
  });

  it('disables Try again while a try is being sent', () => {
    expect(renderToStaticMarkup(<BriefCardView zone="UTC" card={brief({ state: 'failed', state_reason: reason, retries_left: 1 })} busy onRetry={() => {}}/>)).toMatch(/<button[^>]*disabled/);
  });

  it('reads the controls=3 card fields and refuses malformed ones', () => {
    const record = (card: object) => ({ version: 1, view: 'day', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64),
      data: { timezone: 'UTC', date: '2026-10-27', cards: [card], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' } } });
    expect(readControls(record(brief({ state: 'failed', state_reason: reason, retries_left: 3 })), 'day').data.cards[0]).toMatchObject({ state: 'failed', state_reason: reason, retries_left: 3 });
    for (const invalid of [{ state: 'ready' }, { state_reason: 7 }, { retries_left: 4 }, { retries_left: 1.5 }])
      expect(() => readControls(record(brief(invalid as Partial<Card>)), 'day')).toThrow();
  });
});
