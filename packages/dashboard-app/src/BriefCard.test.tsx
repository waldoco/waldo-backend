import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefCardView } from './BriefCard';
import { readControls, type DayRecord } from './controls-model';

type Card = DayRecord['data']['cards'][number];
const brief = (over: Partial<Card> = {}): Card => ({ id: 'card:brief', name: 'The Brief', defaultTime: '08:00', time: '08:00', reason: 'planned', sent: false, pin: null, ...over });
const reason = 'Waldo couldn’t reach its model this morning';

describe('the console Brief card, from the same day view the app reads', () => {
  it('says the Brief could not be made, why, and offers Try again while tries are left', () => {
    const html = renderToStaticMarkup(<BriefCardView card={brief({ state: 'failed', state_reason: reason, retries_left: 2 })} busy={false} onRetry={() => {}}/>);
    expect(html).toContain('Couldn’t make your Brief');
    expect(html).toContain(reason);
    expect(html).toContain('>Try again<');
    expect(html).toContain('2 tries left today');
    expect(renderToStaticMarkup(<BriefCardView card={brief({ state: 'failed', state_reason: reason, retries_left: 0 })} busy={false} onRetry={() => {}}/>)).not.toContain('Try again');
  });

  it('names a paused card, one being made, and one that went out, with Try again only where it helps', () => {
    expect(renderToStaticMarkup(<BriefCardView card={brief({ state: 'paused', state_reason: 'Paused after 3 failed tries in a row', retries_left: 3 })} busy={false} onRetry={() => {}}/>)).toContain('Try again');
    const making = renderToStaticMarkup(<BriefCardView card={brief({ state: 'generating', state_reason: 'Waldo is making it now', retries_left: 2 })} busy={false} onRetry={() => {}}/>);
    expect(making).toContain('Making your Brief now');
    expect(making).not.toContain('Try again');
    expect(renderToStaticMarkup(<BriefCardView card={brief({ sent: true, state: 'sent', retries_left: 3 })} busy={false} onRetry={() => {}}/>)).not.toContain('Try again');
  });

  it('says why a skipped Brief was skipped, with no Try again: the server gives a skipped card no tries', () => {
    const html = renderToStaticMarkup(<BriefCardView card={brief({ sent: true, state: 'skipped', state_reason: reason })} busy={false} onRetry={() => {}}/>);
    expect(html).toContain('Couldn’t make your Brief');
    expect(html).toContain(reason);
    expect(html).not.toContain('Try again');
  });

  it('disables Try again while a try is being sent', () => {
    expect(renderToStaticMarkup(<BriefCardView card={brief({ state: 'failed', state_reason: reason, retries_left: 1 })} busy onRetry={() => {}}/>)).toMatch(/<button[^>]*disabled/);
  });

  it('reads the controls=3 card fields and refuses malformed ones', () => {
    const record = (card: object) => ({ version: 1, view: 'day', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64),
      data: { timezone: 'UTC', date: '2026-10-27', cards: [card], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' } } });
    expect(readControls(record(brief({ state: 'failed', state_reason: reason, retries_left: 3 })), 'day').data.cards[0]).toMatchObject({ state: 'failed', state_reason: reason, retries_left: 3 });
    for (const invalid of [{ state: 'ready' }, { state_reason: 7 }, { retries_left: 4 }, { retries_left: 1.5 }])
      expect(() => readControls(record(brief(invalid as Partial<Card>)), 'day')).toThrow();
  });
});
