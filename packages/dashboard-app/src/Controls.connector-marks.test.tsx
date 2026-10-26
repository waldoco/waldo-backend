// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConnectionsControls } from './Controls';
import { connectorLogo } from './icons';
import telegram from './assets/logos/telegram.svg?inline';
import granola from './assets/logos/granola.svg?inline';
import notion from './assets/logos/notion.svg?inline';
import linear from './assets/logos/linear.svg?inline';
import slack from './assets/logos/slack.svg?inline';
import whatsapp from './assets/logos/whatsapp.svg?inline';
import type { ConnectionsRecord, McpCatalogueTile, McpServerRecord } from './controls-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const consent = ' Connecting here lets the tools Notion labels read-only run without asking when you ask Waldo yourself; anything else, or anything a message or page from outside prompts, asks you first.';
const tiles: McpCatalogueTile[] = [
  { id: 'granola', label: 'Granola', about: 'Read your meeting notes and transcripts. Waldo never changes anything in Granola.', url: 'https://mcp.granola.ai/mcp', connected: false },
  { id: 'notion', label: 'Notion', about: 'Search and read your pages and databases.' + consent, url: 'https://mcp.notion.com/mcp', connected: false },
  { id: 'todoist', label: 'Todoist', about: 'Find and read your tasks and projects.', url: 'https://ai.todoist.net/mcp', connected: false },
  { id: 'zapier', label: 'zapier', about: 'Automations.', url: 'https://mcp.zapier.example/mcp', connected: false },
  { id: 'linear', label: 'Linear', about: 'Find and read issues.', url: 'https://mcp.linear.app/mcp', connected: true },
];
const server = (name: string, url: string): McpServerRecord => ({ id: `s-${name}`, name, host: new URL(url).host, server_url: url, auth: 'oauth', status: 'active', scopes: [], wants_scopes: [], tools: 0, hidden_tools: 0, runs_without_asking: 0, marked_read_only: 0, tools_changed: false, tools_capped: false, read_only_digest: 'b'.repeat(64), tool_list: [] });
const record: ConnectionsRecord = { version: 1, view: 'connections', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64), data: {
  google: { connectAvailable: true, accounts: [{ id: 'g1', email: 'sample@example.test', calendar: true, mail: true, tasks: false, health: 'access_granted' }] },
  telegram: { linked: true, unlinkAvailable: true },
  sessions: { count: 1, until: '2026-10-27 07:30', items: [] },
  channels: [{ channel: 'imessage', state: 'linked', masked_label: 'Your iPhone' }, { channel: 'whatsapp', state: 'unlinked', masked_label: null }],
  mcp: [server('Linear', 'https://mcp.linear.app/mcp'), server('Custom', 'https://mcp.custom.example/mcp')], mcp_catalogue: tiles,
} };

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; });
const mount = () => {
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => root!.render(<ConnectionsControls record={record} busy={false} onAction={vi.fn()}/>));
  const row = (name: string) => [...host.querySelectorAll('li.branch')].find(li => li.querySelector('.value')?.textContent === name)!;
  return { host, row };
};
const mark = (row: Element) => row.querySelector<HTMLElement>('.marks [data-connector]')!;

describe('connector marks on Connections', () => {
  it('keys marks by catalogue id and channel name, never through the prototype', () => {
    for (const [id, src] of [['telegram', telegram], ['granola', granola], ['notion', notion], ['linear', linear], ['slack', slack], ['whatsapp', whatsapp]] as const) expect(connectorLogo(id)).toBe(src);
    expect(new Set([telegram, granola, notion, linear, slack, whatsapp]).size).toBe(6);
    for (const id of ['todoist', 'imessage', 'zapier', 'constructor', '__proto__', 'toString']) expect(connectorLogo(id)).toBeUndefined();
  });

  it('draws each catalogue tile and chat row with its own mark, decorative and hidden from assistive tech', () => {
    const { row } = mount();
    for (const [name, id, letter] of [['Todoist', 'todoist', 'T'], ['iMessage', 'imessage', 'I']] as const) {
      const drawn = mark(row(name));
      expect(drawn.dataset.connector).toBe(id);
      expect(drawn.className).toBe('lettermark');
      expect(drawn.textContent).toBe(letter);
      expect(drawn.getAttribute('aria-hidden')).toBe('true');
    }
    for (const [name, id, src] of [['Telegram', 'telegram', telegram], ['WhatsApp', 'whatsapp', whatsapp], ['Granola', 'granola', granola], ['Notion', 'notion', notion]] as const) {
      const logo = mark(row(name));
      expect(logo.dataset.connector).toBe(id);
      expect(logo.tagName).toBe('IMG');
      expect(logo.getAttribute('src')).toBe(src);
      expect(logo.getAttribute('alt')).toBe('');
      expect(logo.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('falls back to a lettermark from the label for an id it does not know', () => {
    const { row } = mount();
    const drawn = mark(row('zapier'));
    expect(drawn.dataset.connector).toBe('zapier');
    expect(drawn.className).toBe('lettermark');
    expect(drawn.textContent).toBe('Z');
  });

  it('marks a connected catalogue server with its catalogue mark and leaves a custom server on the generic glyph', () => {
    const { row } = mount();
    const connected = mark(row('Linear · mcp.linear.app'));
    expect(connected.dataset.connector).toBe('linear');
    expect(connected.getAttribute('src')).toBe(linear);
    const custom = row('Custom · mcp.custom.example');
    expect(custom.querySelector('.marks [data-connector]')).toBeNull();
    expect(custom.querySelector('.marks .icon')).not.toBeNull();
  });
});

describe('explanations behind an (i) on Connections', () => {
  it('keeps the name, purpose and Connect button on a tile and moves the rest of its text behind the (i), verbatim', () => {
    const { row } = mount();
    const notion = row('Notion');
    const tip = notion.querySelector<HTMLButtonElement>('button.info-button')!;
    expect(tip.getAttribute('aria-label')).toBe('About Notion');
    const hidden = document.getElementById(tip.getAttribute('aria-controls')!)!;
    expect(hidden.textContent).toBe(consent.trim());
    expect(hidden.hidden).toBe(true);
    expect(notion.querySelector('.meta')!.textContent).toBe(tiles[1]!.about);
    expect([...notion.querySelectorAll('button')].some(b => b.textContent === 'Connect Notion')).toBe(true);
    act(() => tip.click());
    expect(hidden.hidden).toBe(false);
  });

  it('puts the chat rows, Google and server-address notes behind an (i) each', () => {
    const { host, row } = mount();
    const labels = [...host.querySelectorAll('button.info-button')].map(b => b.getAttribute('aria-label'));
    expect(labels).toEqual(expect.arrayContaining(['About Google accounts', 'About Telegram', 'About iMessage', 'About WhatsApp', 'About This console', 'About Granola', 'About Notion', 'About Linear', 'About Custom', 'About Server address']));
    const google = host.querySelector('.tree-group .info-button')!;
    const googleText = document.getElementById(google.getAttribute('aria-controls')!)!;
    expect(googleText.textContent).toBe('Saved access is permission, not proof that a live Calendar, Gmail or Tasks request worked. Google asks for its usual scopes together and lets you pick the account. Mail sends still need your exact approval in chat.');
    expect(row('sample@example.test').textContent).not.toContain('Saved access is permission');
    expect(row('WhatsApp').querySelector('.disclosure-body p')!.textContent).toBe('Chat with your Waldo on WhatsApp. It’s the same Waldo and memory as here. Get a one-time code, then send it from your WhatsApp to the Waldo number.');
  });
});
