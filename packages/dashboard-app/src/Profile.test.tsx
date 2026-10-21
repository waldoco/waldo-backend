// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ProfileCards } from './Profile';
it('shows one fact per section and taps through the rest, escaping text', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<ProfileCards sections={[{ title: 'Rhythm', lines: ['<b>Early</b>', 'Late lunch', ''] }, { title: 'Empty', lines: [] }]}/>));
    expect(host.querySelectorAll('.pstack')).toHaveLength(1);
    const card = host.querySelector<HTMLButtonElement>('.pcard')!;
    expect(card.textContent).toContain('<b>Early</b>'); expect(card.textContent).toContain('1 of 2'); expect(host.querySelector('b')).toBeNull();
    await act(async () => card.click());
    expect(card.textContent).toContain('Late lunch'); expect(card.textContent).toContain('2 of 2');
    await act(async () => card.click());
    expect(card.textContent).toContain('1 of 2');
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
