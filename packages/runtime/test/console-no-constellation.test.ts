import { describe, expect, it } from 'vitest';
import { classicConsoleRedirect, CONSOLE_ACTIONS, CONSOLE_PAGES, parseConsoleAction, renderConsole } from '../src/channels/console';
import { STEP_UP_ACTIONS } from '../src/channels/console-step-up';
import { CONTROL_VIEW_ACTIONS } from '../src/channels/dashboard-control-actions';
import { DASHBOARD_RECEIPT_KEYS } from '../src/channels/dashboard-receipts';
import { memoryControl } from '../src/channels/dashboard-memory-actions';
import { SAMPLE_CONSOLE_VIEW } from './fixtures/console-sample';

// The constellation is retired from the console: no page, no section, no node.forget action, and an old link opens Memory.
describe('the console without a constellation', () => {
  it('offers no node.forget action anywhere it is listed, and refuses one posted anyway', () => {
    expect(CONSOLE_ACTIONS).not.toContain('node.forget');
    expect(Object.keys(STEP_UP_ACTIONS)).not.toContain('node.forget');
    expect(Object.values(CONTROL_VIEW_ACTIONS).flat()).not.toContain('node.forget');
    expect(DASHBOARD_RECEIPT_KEYS.filter(key => key.startsWith('node.'))).toEqual([]);
    const form = new FormData(); form.set('action', 'node.forget'); form.set('csrf', 'csrf-1'); form.set('id', '1');
    expect(parseConsoleAction(form, 'csrf-1')).toBeNull();
  });

  it('has no constellation page or section, and a memory control never resolves a node id', () => {
    expect(CONSOLE_PAGES.map(page => page.slug)).not.toContain('constellation');
    expect(renderConsole(SAMPLE_CONSOLE_VIEW, 'memory')).not.toMatch(/Constellation|Tentative association/);
    expect(memoryControl(SAMPLE_CONSOLE_VIEW, 'owner-a', 'owner-a:node:1')).toBeNull();
  });

  it('opens Memory for an old constellation link', () => {
    expect(classicConsoleRedirect(new Request('https://waldo.test/console/constellation'))?.headers.get('location')).toBe('/console#/memory');
  });
});
