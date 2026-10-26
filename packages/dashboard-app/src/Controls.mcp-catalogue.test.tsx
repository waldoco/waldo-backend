// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConnectionsControls } from './Controls';
import type { ConnectionsRecord, McpCatalogueTile } from './controls-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tiles: McpCatalogueTile[] = [
  { id: 'notion', label: 'Notion', about: 'Search and read your pages.', url: 'https://mcp.notion.com/mcp', connected: false },
  { id: 'linear', label: 'Linear', about: 'Issues and projects.', url: 'https://mcp.linear.app/mcp', connected: true },
];
const record: ConnectionsRecord = { version: 1, view: 'connections', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64), data: {
  google: { connectAvailable: true, accounts: [] }, telegram: { linked: false, unlinkAvailable: false },
  sessions: { count: 1, until: '2026-10-27 07:30', items: [{ signed_in: '2026-10-26 19:30', until: '2026-10-27 07:30', current: true }] },
  mcp: [], mcp_catalogue: tiles,
} };

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; });

describe('official MCP servers in Connections', () => {
  it('marks a read allowed on connect and makes it a standing permission in one click', () => {
    const onAction = vi.fn();
    const notion = { id: 'c1', name: 'notion', host: 'mcp.notion.com', server_url: 'https://mcp.notion.com/mcp', auth: 'oauth' as const, status: 'active' as const, scopes: [], wants_scopes: [], tools: 2, hidden_tools: 0, runs_without_asking: 1, marked_read_only: 1, tools_changed: false, tools_capped: false, read_only_digest: 'b'.repeat(64),
      tool_list: [{ tool: 'notion-search', runs: 'without_asking' as const, read_only_hint: true, digest: 'a'.repeat(64), allowed_on_connect: true as const }, { tool: 'notion-create-pages', runs: 'asks_first' as const, read_only_hint: false, digest: 'c'.repeat(64) }] };
    const host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => root!.render(<ConnectionsControls record={{ ...record, data: { ...record.data, mcp: [notion] } }} busy={false} onAction={onAction}/>));
    expect(host.textContent).toContain('allowed when you connected: runs without asking only when you ask Waldo yourself');
    const upgrades = [...host.querySelectorAll('button')].filter((button) => button.textContent === 'Run without asking in every chat');
    expect(upgrades).toHaveLength(1);
    act(() => upgrades[0]!.click());
    expect(onAction).toHaveBeenCalledWith('mcp.runs', { id: 'c1', value: `notion-search|on|${'a'.repeat(64)}` });
  });

  it('connects an official server in one click with its exact address and catalogue id, and offers only servers not yet connected', () => {
    const onAction = vi.fn();
    const host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => root!.render(<ConnectionsControls record={record} busy={false} onAction={onAction}/>));
    expect(host.textContent).toContain('Search and read your pages.');
    const buttons = [...host.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons).toContain('Connect Notion');
    expect(buttons).not.toContain('Connect Linear');
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Connect Notion')!.click());
    expect(onAction).toHaveBeenCalledWith('mcp.connect', { value: 'https://mcp.notion.com/mcp', id: 'notion' });
  });
});
