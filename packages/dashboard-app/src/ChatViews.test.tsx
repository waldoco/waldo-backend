// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readChatPage, visibleText, type ChatMessage } from './chat-model';
import { ViewCard } from './ChatViews';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOTELS = { kind: 'options', title: 'North Goa', items: [
  { title: 'Ronil Beach Resort', subtitle: 'Baga', facts: [{ label: 'Per night', value: '₹5,400' }], link: 'https://www.example.com/ronil', pick: true },
  { title: 'Casa Anjuna', note: 'Quiet.\nNine rooms.', link: 'javascript:alert(1)' },
] };
const FLIGHTS = { kind: 'table', columns: ['Flight', 'Departs', 'Price'], rows: Array.from({ length: 10 }, (_, i) => [`6E ${500 + i}`, `0${i}:10`, i === 3 ? '' : `₹4,${800 + i}`]) };
const page = (text: string, parts: unknown[]) => readChatPage({ messages: [{ id: 'a1', role: 'assistant', text, parts, channel: 'app', parent_id: null, created_at: 1_760_000_000_000 }], next_cursor: null });
const viewOf = (message: ChatMessage, n = 0) => message.parts.filter(part => part.type === 'view')[n]!;

let root: Root | null = null, host: HTMLElement | null = null;
const mount = async (element: React.ReactElement) => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(element)); return host; };
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; });

describe('reading views', () => {
  it('reads each kind, keeps only links that open as given, and drops a view or entry it cannot draw', () => {
    const [message] = page('x', [
      { type: 'view', view: HOTELS, fallback_text: 'hotels' },
      { type: 'view', view: { ...FLIGHTS, rows: [['6E 1', '06:10'], ...FLIGHTS.rows] }, fallback_text: 'flights' },
      { type: 'view', view: { kind: 'steps', items: [{ title: 'Book', state: 'done' }, { title: 'Pack', state: 'later' }, { title: '' }] }, fallback_text: 'steps' },
      { type: 'view', view: { kind: 'timeline', items: [{ when: '09:00', title: 'Standup' }] }, fallback_text: 'day' },
      { type: 'view', view: { kind: 'html', html: '<b>x</b>' }, fallback_text: 'nope' },
      { type: 'view', view: { kind: 'steps', items: [] }, fallback_text: 'empty' },
    ]).messages;
    expect(message!.parts.map(part => part.type === 'view' ? part.view.kind : part.type)).toEqual(['options', 'table', 'steps', 'timeline']);
    const options = viewOf(message!).view;
    expect(options.kind === 'options' && options.items.map(item => item.link)).toEqual(['https://www.example.com/ronil', null]);
    const table = viewOf(message!, 1).view;
    expect(table.kind === 'table' && table.rows).toHaveLength(10);
    const steps = viewOf(message!, 2).view;
    expect(steps.kind === 'steps' && steps.items).toEqual([{ title: 'Book', detail: null, state: 'done' }, { title: 'Pack', detail: null, state: null }]);
  });

  it('hides each view\'s text and the receipt line from the words, only where the text repeats them exactly', () => {
    const receipt = { type: 'receipt', items: [{ kind: 'reminder_set', target: null, outcome: 'accepted', via_task: false, at: 1_760_000_000_000, digest: null }], more: 0, fallback_text: 'Done: reminder set' };
    const parts = [{ type: 'view', view: HOTELS, fallback_text: 'North Goa\n1. Ronil' }, { type: 'view', view: FLIGHTS, fallback_text: 'Flight | Price' }, receipt];
    expect(visibleText(page('Two picks.\n\nNorth Goa\n1. Ronil\n\nFlight | Price\n\nDone: reminder set', parts).messages[0]!)).toBe('Two picks.');
    expect(visibleText(page('Two picks.\n\nsomething else', parts).messages[0]!)).toBe('Two picks.\n\nsomething else');
    // A view this console could not read keeps its text in the words.
    expect(visibleText(page('Two picks.\n\nmystery', [{ type: 'view', view: { kind: 'map' }, fallback_text: 'mystery' }]).messages[0]!)).toBe('Two picks.\n\nmystery');
  });
});

describe('drawing views', () => {
  it('draws options with Waldo\'s pick, facts and a safe outbound link', async () => {
    const [message] = page('x', [{ type: 'view', view: HOTELS, fallback_text: 'hotels' }]).messages;
    const view = await mount(<ViewCard part={viewOf(message!)}/>);
    expect(view.querySelector('section')?.getAttribute('aria-label')).toBe('North Goa');
    expect([...view.querySelectorAll('.view-option')].map(item => item.classList.contains('pick'))).toEqual([true, false]);
    expect(view.querySelector('.pick .access-label')?.textContent).toBe('Waldo’s pick');
    expect(view.querySelector('.view-facts dd')?.textContent).toBe('₹5,400');
    const links = view.querySelectorAll<HTMLAnchorElement>('a');
    expect(links).toHaveLength(1);
    expect(links[0]!.textContent).toBe('example.com');
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(links[0]!.getAttribute('target')).toBe('_blank');
    expect(view.innerHTML).not.toContain('javascript:');
  });

  it('draws model text as text, never as markup', async () => {
    const [message] = page('x', [{ type: 'view', view: { kind: 'timeline', items: [{ when: '09:00', title: '<img src=x onerror=alert(1)>' }] }, fallback_text: 'day' }]).messages;
    const view = await mount(<ViewCard part={viewOf(message!)}/>);
    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('.view-timeline .strong')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('shows the first rows of a long table, aligns amounts, and opens the rest on request', async () => {
    const [message] = page('x', [{ type: 'view', view: FLIGHTS, fallback_text: 'flights' }]).messages;
    const view = await mount(<ViewCard part={viewOf(message!)}/>);
    expect(view.querySelectorAll('tbody tr')).toHaveLength(8);
    expect([...view.querySelectorAll('thead th')].map(th => th.className)).toEqual(['', 'num', 'num']);
    expect(view.querySelectorAll('tbody tr')[3]!.lastElementChild!.textContent).toBe('–');
    const more = view.querySelector<HTMLButtonElement>('.view-more')!;
    expect(more.textContent).toBe('Show all 10 rows');
    await act(async () => more.click());
    expect(view.querySelectorAll('tbody tr')).toHaveLength(10);
    expect(more.getAttribute('aria-expanded')).toBe('true');
  });

  it('marks a plan\'s steps and says how far it has come', async () => {
    const [message] = page('x', [{ type: 'view', view: { kind: 'steps', title: 'Trip', items: [{ title: 'Book', state: 'done' }, { title: 'Pack', state: 'current' }, { title: 'Go', state: 'todo' }] }, fallback_text: 'steps' }]).messages;
    const view = await mount(<ViewCard part={viewOf(message!)}/>);
    expect([...view.querySelectorAll('.view-step')].map(step => step.className)).toEqual(['view-step done', 'view-step current', 'view-step todo']);
    expect(view.querySelector('.view-progress .meta')?.textContent).toBe('1 of 3 done');
    expect(view.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('1');
    expect(view.querySelectorAll('.view-step')[1]!.textContent).toContain('in progress');
  });

  it('leaves out the progress bar for a plain list of steps', async () => {
    const [message] = page('x', [{ type: 'view', view: { kind: 'steps', items: [{ title: 'One' }, { title: 'Two' }] }, fallback_text: 'steps' }]).messages;
    const view = await mount(<ViewCard part={viewOf(message!)}/>);
    expect(view.querySelector('.view-progress')).toBeNull();
    expect([...view.querySelectorAll('.view-step-mark')].map(mark => mark.textContent)).toEqual(['1', '2']);
  });
});
