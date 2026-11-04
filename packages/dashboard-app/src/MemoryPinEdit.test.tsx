// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryActions, readMemoryControls } from './MemoryActions';

const id = 'owner:claim:7';
const wire = (actions: string[], target = id) => ({ version: 1, view: 'memory', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64),
  data: { id: target, status: 'active', review: { label: 'Likes tea', note: 'Writer note' }, actions } });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; window.location.hash = ''; });

// Renders the item's controls with the given actions, and keeps every POST the panel makes.
const panel = async (actions: string[], answer: () => Response = () => Response.json({ duplicate: false, receipt: { state: 'recorded', message: 'Saved.' } }), target = id) => {
  const posts: FormData[] = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push(init.body as FormData); return answer(); }
    return Response.json(wire(actions, target));
  }));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<MemoryActions id={target}/>));
  await flush();
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label);
  return { host, root, posts, button };
};

describe('pinning and editing a Spot from the dashboard', () => {
  it('accepts the pin, unpin and edit actions from the item read', () => {
    expect(readMemoryControls(wire(['spot.pin', 'spot.edit', 'spot.dismiss']), id).data.actions).toEqual(['spot.pin', 'spot.edit', 'spot.dismiss']);
    expect(readMemoryControls(wire(['spot.unpin']), id).data.actions).toEqual(['spot.unpin']);
  });

  it('pins to the block the owner picks', async () => {
    const view = await panel(['spot.pin', 'spot.edit', 'spot.dismiss', 'spot.forget']);
    await act(async () => view.button('Pin to facts')!.click());
    await flush();
    expect(view.posts.map(body => [body.get('action'), body.get('value'), body.get('id')])).toEqual([['spot.pin', 'facts', id]]);
    await act(async () => view.root.unmount());
  });

  it('saves the owner\'s corrected text, trimmed, and never sends an empty edit', async () => {
    const view = await panel(['spot.edit', 'spot.dismiss']);
    const field = view.host.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(field.value).toBe('Likes tea');
    expect(field.maxLength).toBe(1000);
    const type = (text: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await type('   ');
    expect(view.button('Save edit')!.disabled).toBe(true);
    await type('  Likes green tea  ');
    await act(async () => view.button('Save edit')!.click());
    await flush();
    expect(view.posts.map(body => [body.get('action'), body.get('value')])).toEqual([['spot.edit', 'Likes green tea']]);
    await act(async () => view.root.unmount());
  });

  it('confirms a pattern, and corrects it in the owner\'s words', async () => {
    const node = 'owner:node:3';
    const view = await panel(['node.confirm', 'node.correct', 'node.forget'], undefined, node);
    const field = view.host.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(view.host.textContent).toContain('Correct this pattern in your words');
    expect(field.maxLength).toBe(140);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, ' Writes in the late morning ');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => view.button('Save edit')!.click());
    await flush();
    await act(async () => view.button('That’s right')!.click());
    await flush();
    expect(view.posts.map(body => [body.get('action'), body.get('value'), body.get('id')])).toEqual([['node.correct', 'Writes in the late morning', node], ['node.confirm', null, node]]);
    await act(async () => view.root.unmount());
  });

  it('offers the email code when a pin is refused for an old one', async () => {
    window.location.hash = '#/memory';
    const view = await panel(['spot.pin'], () => Response.json({ error: 'step_up_required' }, { status: 403 }));
    await act(async () => view.button('Pin to profile')!.click());
    await flush();
    const link = [...view.host.querySelectorAll<HTMLAnchorElement>('a')].find(a => a.getAttribute('href')?.startsWith('/console/signin?confirm=1'));
    expect(link?.getAttribute('href')).toBe('/console/signin?confirm=1#/memory');
    await act(async () => view.root.unmount());
  });
});
