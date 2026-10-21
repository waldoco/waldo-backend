// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GraphMap } from './GraphMap';

it('recovers a focused target after off-canvas pan without discarding zoom or node positions', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<GraphMap nodes={[{ id: 'a', kind: 'pattern', label: 'Saved pattern' }]} links={[]} selected="a" onSelect={() => {}} reduced />));
    for (let i = 0; i < 5; i++) await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
    for (let i = 0; i < 20; i++) await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Pan right"]')!.click());
    const node = host.querySelector<SVGGElement>('[data-node=a]')!;
    const scroll = vi.spyOn(node, 'scrollIntoView');
    const position = node.getAttribute('transform'), offCanvas = host.querySelector('svg>g')!.getAttribute('transform');
    await act(async () => node.focus());
    expect(document.activeElement).toBe(node);
    expect(host.querySelector('output')?.textContent).toBe('175%');
    expect(node.getAttribute('transform')).toBe(position);
    expect(host.querySelector('svg>g')!.getAttribute('transform')).not.toBe(offCanvas);
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'center' });
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it('allows native background touch scrolling in both axes while keeping node dragging isolated', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const style = document.createElement('style'); style.textContent = readFileSync(new NodeURL('./style.css', import.meta.url), 'utf8'); document.head.append(style);
  const host = document.createElement('div'); host.className = 'constellation-canvas'; document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<GraphMap nodes={[{ id: 'a', kind: 'pattern', label: 'Saved pattern' }]} links={[]} selected="a" onSelect={() => {}} reduced />));
    expect(getComputedStyle(host.querySelector('svg')!).touchAction).toBe('pan-x pan-y');
    expect(getComputedStyle(host.querySelector('.graph-node')!).touchAction).toBe('none');
    const before = host.querySelector('svg>g')!.getAttribute('transform');
    await act(async () => {
      host.querySelector('svg')!.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 300, clientY: 100, bubbles: true }));
      host.querySelector('svg')!.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100, bubbles: true }));
    });
    expect(host.querySelector('svg>g')!.getAttribute('transform')).toBe(before);
  } finally { await act(async () => root.unmount()); host.remove(); style.remove(); vi.unstubAllGlobals(); }
});
