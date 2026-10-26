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
  it('connects an official server in one click with its exact address, and offers only servers not yet connected', () => {
    const onAction = vi.fn();
    const host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => root!.render(<ConnectionsControls record={record} busy={false} onAction={onAction}/>));
    const buttons = [...host.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons).toContain('Connect Notion');
    expect(buttons).not.toContain('Connect Linear');
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Connect Notion')!.click());
    expect(onAction).toHaveBeenCalledWith('mcp.connect', { value: 'https://mcp.notion.com/mcp' });
  });
});
