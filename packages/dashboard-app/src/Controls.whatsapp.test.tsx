// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionsControls } from './Controls';
import type { ConnectionsRecord } from './controls-model';

const record = (channels?: ConnectionsRecord['data']['channels']): ConnectionsRecord => ({ version: 1, view: 'connections', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64), data: {
  google: { connectAvailable: true, accounts: [] }, telegram: { linked: false, unlinkAvailable: false },
  sessions: { until: '2026-10-16 18:00', count: 1, items: [] }, ...(channels ? { channels } : {}),
} });
const mount = async (value: ConnectionsRecord, onAction = vi.fn()) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<ConnectionsControls record={value} busy={false} onAction={onAction}/>));
  const row = [...host.querySelectorAll('li.branch')].find(li => li.querySelector('.value')?.textContent === 'WhatsApp')!;
  const unlink = [...row.querySelectorAll('button')].find(b => b.textContent === 'Unlink WhatsApp');
  return { row, unlink, onAction, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
};
afterEach(() => vi.unstubAllGlobals());

it('shows WhatsApp as linked, not linked, or unknown, and offers unlink only while linked', async () => {
  for (const [channels, label, offered, link] of [
    [[{ channel: 'whatsapp', state: 'linked', masked_label: 'Your WhatsApp' }], 'Linked', true, 'Link a different number'],
    [[{ channel: 'whatsapp', state: 'unlinked', masked_label: null }], 'Not linked', false, 'Link WhatsApp'],
    [[{ channel: 'imessage', state: 'linked', masked_label: 'Your iPhone' }], 'Status unknown', false, 'Link WhatsApp'],
    [undefined, 'Status unknown', false, 'Link WhatsApp'],
  ] as const) {
    const view = await mount(record(channels as ConnectionsRecord['data']['channels']));
    expect(view.row.querySelector('.access-label')?.textContent).toBe(label);
    // The connector is solid ("Access saved") only while linked; unknown and not linked draw it broken.
    expect(view.row.classList.contains('broken')).toBe(label !== 'Linked');
    expect(view.row.querySelector('.access-label')!.classList.contains('reconnect')).toBe(label === 'Not linked');
    expect(!!view.unlink).toBe(offered);
    const button = [...view.row.querySelectorAll('button')].find(b => b.textContent === link);
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(view.onAction).toHaveBeenCalledWith('whatsapp.link');
    await view.cleanup();
  }
});

it('asks before unlinking and sends nothing when the owner cancels', async () => {
  const confirm = vi.fn(() => false); vi.stubGlobal('confirm', confirm);
  const view = await mount(record([{ channel: 'whatsapp', state: 'linked', masked_label: 'Your WhatsApp' }]));
  await act(async () => view.unlink!.click());
  expect(confirm).toHaveBeenCalledTimes(1); expect(view.onAction).not.toHaveBeenCalled();
  confirm.mockReturnValueOnce(true);
  await act(async () => view.unlink!.click());
  expect(view.onAction).toHaveBeenCalledWith('whatsapp.unlink');
  await view.cleanup();
});
