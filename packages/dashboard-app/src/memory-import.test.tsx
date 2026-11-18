// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_MEMORY_IMPORT_PROMPT_V1, APP_MEMORY_IMPORT_SOURCE_NAMES_V1, APP_MEMORY_IMPORT_SOURCES_V1, APP_MEMORY_IMPORT_TEXT_MAX_V1, APP_MEMORY_IMPORT_TEXT_MIN_V1, appMemoryImportRequestV1Schema,
} from '../../contracts/src/app/memory-import';
import { MemoryImportPanel } from './MemoryImport';
import { importFailureLine, MEMORY_IMPORT_PROMPT, MEMORY_IMPORT_SOURCES, MEMORY_IMPORT_TEXT_MAX, MEMORY_IMPORT_TEXT_MIN, MEMORY_IMPORT_URL, textRefusal } from './memory-import-model';

const PASTED = 'Meera lives in Pune and runs a small design studio. She prefers short answers.';
const result = { version: 1, state: 'imported', added: 2, already_known: 0, left_out: 0, message: 'Waldo kept 2 things from it. They show as "Waldo thinks" in What Waldo knows until you confirm them.' };

const serve = (available: boolean | 404, post: () => Response = () => Response.json(result)) => {
  const calls: { method: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    expect(url).toBe(MEMORY_IMPORT_URL);
    const method = init.method ?? 'GET';
    calls.push({ method, body: init.body ? JSON.parse(String(init.body)) : null });
    if (method === 'GET') return available === 404 ? Response.json({ error: 'not_found' }, { status: 404 }) : Response.json({ version: 1, available });
    return post();
  }));
  return calls;
};
const mount = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<MemoryImportPanel/>));
  return { host, root };
};
const paste = async (host: HTMLElement, text: string) => {
  const box = host.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(box, text); box.dispatchEvent(new Event('input', { bubbles: true })); });
};
const press = async (host: HTMLElement, label: string) => {
  const button = [...host.querySelectorAll('button')].find(candidate => candidate.textContent === label)!;
  await act(async () => button.click());
};
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('the memory import contract, as the console copies it', () => {
  it('agrees with the contract word for word', () => {
    expect(MEMORY_IMPORT_PROMPT).toBe(APP_MEMORY_IMPORT_PROMPT_V1);
    expect(MEMORY_IMPORT_SOURCES.map(item => item.key)).toEqual([...APP_MEMORY_IMPORT_SOURCES_V1]);
    expect(Object.fromEntries(MEMORY_IMPORT_SOURCES.map(item => [item.key, item.label]))).toEqual(APP_MEMORY_IMPORT_SOURCE_NAMES_V1);
    expect([MEMORY_IMPORT_TEXT_MIN, MEMORY_IMPORT_TEXT_MAX]).toEqual([APP_MEMORY_IMPORT_TEXT_MIN_V1, APP_MEMORY_IMPORT_TEXT_MAX_V1]);
  });

  it('refuses before sending only what the route would refuse', () => {
    expect(textRefusal('too short')).not.toBeNull();
    expect(textRefusal('x'.repeat(MEMORY_IMPORT_TEXT_MAX + 1))).not.toBeNull();
    expect(textRefusal(PASTED)).toBeNull();
    expect(importFailureLine(503)).toContain('Nothing was saved');
  });
});

describe('the memory import panel', () => {
  it('is not there while this Waldo does not take imports, or has no such route', async () => {
    for (const available of [false, 404] as const) {
      serve(available);
      const { host, root } = await mount();
      expect(host.textContent).toBe('');
      await act(async () => root.unmount());
    }
  });

  it('copies the prompt, sends the paste with its source, and says what Waldo kept', async () => {
    const calls = serve(true);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { host, root } = await mount();
    await press(host, 'Copy prompt');
    expect(writeText).toHaveBeenCalledWith(APP_MEMORY_IMPORT_PROMPT_V1);
    expect(host.textContent).toContain('Copied.');
    const select = host.querySelector('select')!;
    await act(async () => { select.value = 'gemini'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await paste(host, `  ${PASTED}  `);
    await press(host, 'Bring them in');
    const sent = calls.find(call => call.method === 'POST')!.body;
    expect(appMemoryImportRequestV1Schema.parse(sent)).toMatchObject({ source: 'gemini', text: PASTED });
    expect(host.textContent).toContain('Waldo kept 2 things');
    expect(host.querySelector('textarea')!.value).toBe('');
    await act(async () => root.unmount());
  });

  it('says a failed read kept nothing, and retries the same paste under the same request id', async () => {
    let fail = true;
    const calls = serve(true, () => fail ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(result));
    const { host, root } = await mount();
    await paste(host, PASTED);
    await press(host, 'Bring them in');
    expect(host.textContent).toContain('Nothing was saved');
    fail = false;
    await press(host, 'Bring them in');
    const posts = calls.filter(call => call.method === 'POST').map(call => (call.body as { request_id: string }).request_id);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toBe(posts[1]);
    await act(async () => root.unmount());
  });
});
