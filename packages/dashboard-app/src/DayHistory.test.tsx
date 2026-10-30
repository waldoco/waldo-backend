import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import fixture from '../../contracts/src/app/fixtures/day-history.v1.json';
import { DayView } from './DayHistory';
import { chatSeed, dayLabel, fetchDayDetail, fetchDaysList, readDayDetail, readDaysList, type DayDetail } from './day-history-model';

const detail = readDayDetail(fixture.day);
const view = (over: Partial<DayDetail> = {}, since: string | null = '2026-10-27', onChat = () => {}) =>
  renderToStaticMarkup(<DayView detail={{ ...detail, ...over }} since={since} onChat={onChat}/>);

afterEach(() => { vi.unstubAllGlobals(); });

describe('reading the days view', () => {
  it('reads the app contract\'s list, one day, and a day before history began', () => {
    const list = readDaysList(fixture.list);
    expect([list.today, list.history_since, list.days.length]).toEqual(['2026-10-28', '2026-10-27', 3]);
    expect(list.days[1]!.cards.map(card => card.state)).toEqual(['unknown', 'skipped', 'sent']);
    expect([detail.night.runs.length, detail.night.total, detail.updates.total]).toEqual([2, 2, 0]);
    expect(readDayDetail(fixture.day_before_history).complete).toBe(false);
  });

  it('refuses another view, an unknown state and a malformed run', () => {
    expect(() => readDaysList({ ...fixture.list, view: 'day' })).toThrow();
    expect(() => readDaysList({ ...fixture.list, data: { ...fixture.list.data, days: [{ ...fixture.list.data.days[0], cards: [{ id: 'card:brief', name: 'The Brief', state: 'held' }] }] } })).toThrow();
    expect(() => readDayDetail({ ...fixture.day, data: { ...fixture.day.data, night: { ...fixture.day.data.night, runs: [{ id: 'bg:1', kind: 'nightly' }] } } })).toThrow();
  });

  it('asks the console route for controls=6, with the date for one day', async () => {
    const calls: [string, Headers][] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push([url, new Headers(init.headers)]); return Response.json(url.includes('date=') ? fixture.day : fixture.list); });
    await fetchDaysList();
    await fetchDayDetail('2026-10-28');
    expect(calls.map(([url]) => url)).toEqual(['/console/dashboard/api/v1/chat/days', '/console/dashboard/api/v1/chat/days?date=2026-10-28']);
    expect(calls.every(([, headers]) => headers.get('x-waldo-app-contract') === 'controls=6')).toBe(true);
  });
});

describe('a day on the console', () => {
  it('shows each card with its words and a way to chat about it, and the night before with its runs', () => {
    const html = view();
    expect(html).toContain('A light morning: the design review at 11 is the one to protect.');
    expect(html.match(/Chat about this/g)).toHaveLength(1);
    expect(html).toContain('Still to come');
    expect(html).toContain('Nightly memory pass: memory pass finished');
    expect(html).toContain('Health check: health check ran');
    expect(html).not.toContain('only what was kept');
  });

  it('says so for a day before history, a card with no words, an empty day, updates that went elsewhere, and a night partly lost', () => {
    const before = view({ complete: false, cards: [], night: { ...detail.night, runs: [], total: 0, complete: false } });
    expect(before).toContain('Waldo began keeping day history on Tue 27 Oct');
    expect(before).toContain('No cards were planned or sent this day.');
    expect(before).toContain('Nothing ran that night.');
    expect(before).toContain('some runs may be missing');
    const gone = view({ cards: [{ id: 'card:close', name: 'The Close', state: 'sent', latest: null }], updates: { items: [detail.cards[0]!.latest!], total: 3 } });
    expect(gone).toContain('somewhere other than Chat, or its message is gone');
    expect(gone).toContain('3 updates');
    expect(gone).toContain('2 more went somewhere other than Chat.');
  });

  it('seeds a chat with the card and the day, never the card\'s own words', () => {
    const card = detail.cards[0]!;
    expect(chatSeed(card, '2026-10-28')).toBe('About The Brief on Wed 28 Oct: ');
    expect(chatSeed(card, '2026-10-28')).not.toContain('design review');
    expect(dayLabel('2026-11-01')).toBe('Sun 1 Nov');
  });
});
