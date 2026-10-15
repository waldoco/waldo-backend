// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resolveRoute } from './App';
import { ChatWorkspace } from './ChatThreads';
import { archiveThread, ChatRequestError, createThread, deleteThread, readThread, renameThread, sendChatMessage, type ChatThread } from './chat-model';
import { chatStore, createThreadsStore, dropChatStore, threadDeps, type ThreadsDeps } from './chat-store';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = 'thr_0b9e7f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b', OLD = 'thr_1c9e7f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const thread = (over: Partial<ChatThread> = {}): ChatThread => ({ thread_id: ID, title: 'Goa trip', preview: 'Three hotels under 6k', revision: 1, title_revision: 1, state: 'active', created_at: 1_760_000_000_000, last_activity_at: 1_760_000_000_000, ...over });
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
const history = { messages: [], next_cursor: null };
let root: Root | null = null, host: HTMLElement | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); window.location.hash = ''; });
const mount = async (element: React.ReactElement) => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(element)); await flush(); return host; };
const deps = (list: ChatThread[], over: Partial<ThreadsDeps> = {}): ThreadsDeps => ({ list: async () => list, create: async () => ID, rename: async () => ID, archive: async () => ID, remove: async () => ID, ...over });
const chatFetch = (thread: ChatThread) => vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/threads/') ? { thread, history } : history)));

describe('chat threads in the console', () => {
  it('routes main chat and a thread, and nothing that only looks like one', () => {
    expect(resolveRoute('chat')).toBe('chat');
    expect(resolveRoute(`chat/${ID}`)).toBe(`chat/${ID}`);
    expect(resolveRoute('chat/thr_nope')).toBe('not-found');
    expect(resolveRoute(`chat/${ID}/x`)).toBe('not-found');
  });

  it('lists main first, then live chats, with archived chats folded away', async () => {
    chatFetch(thread());
    const store = createThreadsStore(deps([thread(), thread({ thread_id: OLD, title: null, preview: null, state: 'archived' })]));
    const page = await mount(<ChatWorkspace thread={ID} zone="UTC" threads={store}/>);
    const items = [...page.querySelectorAll('.chat-rail nav[aria-label="Chats"] .thread-item')].map(item => item.querySelector('.thread-title')?.textContent);
    expect(items).toEqual(['Main chat', 'Goa trip']);
    expect(page.querySelector('.thread-item[aria-current="page"] .thread-title')?.textContent).toBe('Goa trip');
    expect(page.querySelector('.chat-archived summary')?.textContent).toContain('1');
    expect(page.querySelector('.chat-archived .thread-title')?.textContent).toBe('New chat');
    expect(page.querySelector('.thread-head h1')?.textContent).toBe('Goa trip');
  });

  it('starts a new chat and opens it', async () => {
    chatFetch(thread());
    const create = vi.fn(async () => ID);
    const page = await mount(<ChatWorkspace thread={null} zone="UTC" threads={createThreadsStore(deps([], { create }))}/>);
    expect(page.querySelector('h1')?.textContent).toBe('Main chat');
    await act(async () => page.querySelector<HTMLButtonElement>('.chat-new')!.click()); await flush();
    expect(create).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe(`#/chat/${ID}`);
  });

  it('locks the composer of an archived chat behind Unarchive', async () => {
    const archived = thread({ state: 'archived', revision: 2 });
    chatFetch(archived);
    const archive = vi.fn(async () => ID);
    const page = await mount(<ChatWorkspace thread={ID} zone="UTC" threads={createThreadsStore(deps([archived], { archive }))}/>);
    expect(page.querySelector('#chat-input')).toBeNull();
    expect(page.querySelector('.chat-locked')?.textContent).toContain('archived');
    await act(async () => page.querySelector<HTMLButtonElement>('.chat-locked button')!.click()); await flush();
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({ thread_id: ID, revision: 2 }), false);
  });

  it('renames in place, and deletes only after confirming, then returns to main', async () => {
    chatFetch(thread());
    const rename = vi.fn(async () => ID), remove = vi.fn(async () => ID);
    const page = await mount(<ChatWorkspace thread={ID} zone="UTC" threads={createThreadsStore(deps([thread()], { rename, remove }))}/>);
    await act(async () => [...page.querySelectorAll<HTMLButtonElement>('.thread-actions button')].find(b => b.textContent === 'Rename')!.click());
    const input = page.querySelector<HTMLInputElement>('#thread-title')!;
    expect(input.value).toBe('Goa trip');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Goa, December'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => page.querySelector<HTMLFormElement>('.thread-rename')!.requestSubmit()); await flush();
    expect(rename).toHaveBeenCalledWith(expect.objectContaining({ thread_id: ID }), 'Goa, December');
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    const del = () => [...page.querySelectorAll<HTMLButtonElement>('.thread-actions button')].find(b => b.textContent === 'Delete')!;
    await act(async () => del().click()); await flush();
    expect(remove).not.toHaveBeenCalled();
    await act(async () => del().click()); await flush();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe('#/chat');
  });

  it('shows a change the owner object refused where the owner acted', async () => {
    chatFetch(thread());
    const archive = vi.fn(async () => { throw new ChatRequestError(409, 'This chat changed in another window. Try again.', 'thread_revision_conflict'); });
    const page = await mount(<ChatWorkspace thread={ID} zone="UTC" threads={createThreadsStore(deps([thread()], { archive }))}/>);
    await act(async () => [...page.querySelectorAll<HTMLButtonElement>('.thread-actions button')].find(b => b.textContent === 'Archive')!.click()); await flush();
    expect(page.querySelector('.thread-head [role="alert"]')?.textContent).toBe('This chat changed in another window. Try again.');
  });
});

describe('thread transport', () => {
  it('sends a thread message against the thread revision, and an operation under a fresh operation id', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ accepted: true, message_id: 'app-9', state: 'admitted', operation_id: 'x', thread_id: ID }));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('7d4c2b1a-0e9f-4a8b-9c7d-6e5f4a3b2c1d');
    await sendChatMessage('console-abcdefgh', 'Hi', ID, 3);
    fetch.mockImplementation(async () => Response.json({ operation_id: 'x', state: 'recorded', thread_id: ID }));
    await createThread();
    await renameThread(thread({ title_revision: 2 }), 'Goa');
    await archiveThread(thread({ revision: 4 }), true);
    await deleteThread(thread({ revision: 5 }));
    const sent = fetch.mock.calls.map(([url, init]) => [url, JSON.parse(String(init!.body))]);
    expect(sent).toEqual([
      [`/console/dashboard/api/v1/chat/threads/${ID}/messages`, { client_message_id: 'console-abcdefgh', text: 'Hi', expected_revision: 3 }],
      ['/console/dashboard/api/v1/chat/threads', { operation_id: '7d4c2b1a-0e9f-4a8b-9c7d-6e5f4a3b2c1d' }],
      [`/console/dashboard/api/v1/chat/threads/${ID}/rename`, { operation_id: '7d4c2b1a-0e9f-4a8b-9c7d-6e5f4a3b2c1d', expected_title_revision: 2, title: 'Goa' }],
      [`/console/dashboard/api/v1/chat/threads/${ID}/archive`, { operation_id: '7d4c2b1a-0e9f-4a8b-9c7d-6e5f4a3b2c1d', expected_revision: 4, archived: true }],
      [`/console/dashboard/api/v1/chat/threads/${ID}/delete`, { operation_id: '7d4c2b1a-0e9f-4a8b-9c7d-6e5f4a3b2c1d', expected_revision: 5 }],
    ]);
  });

  it('resends once against the new revision when the thread moved, and never on any other refusal', async () => {
    let revision = 1;
    const sends: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return Response.json({ thread: thread({ revision }), history });
      const body = JSON.parse(String(init.body)) as { expected_revision: number };
      sends.push(body.expected_revision);
      return body.expected_revision === revision ? Response.json({ accepted: true, message_id: 'app-1', state: 'admitted' }) : Response.json({ error: 'thread_revision_conflict' }, { status: 409 });
    }));
    const store = createThreadsStore(deps([]));
    const send = threadDeps(ID, store).send;
    await send('console-abcdefgh', 'Hi');
    revision = 3;
    await send('console-abcdefgh', 'Hi again');
    expect(sends).toEqual([1, 1, 3]);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? Response.json({ error: 'thread_archived' }, { status: 409 }) : Response.json({ thread: thread(), history })));
    await expect(threadDeps(ID, store).send('console-abcdefgh', 'Hi')).rejects.toMatchObject({ code: 'thread_archived', message: 'This chat is archived. Unarchive it to keep talking here.' });
  });

  it('says the chat limit when the owner object refuses a new chat for it, though it arrives as a 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'thread_capacity' }, { status: 429 })));
    await expect(createThread()).rejects.toMatchObject({ status: 429, code: 'thread_capacity', message: 'You’ve reached the most chats Waldo keeps. Delete one you no longer need first.' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '30' } })));
    await expect(createThread()).rejects.toMatchObject({ status: 429, retryAfter: 30, message: 'Waldo is getting a lot of messages from you right now. Try again in a minute.' });
  });

  it('lets go of a deleted thread\'s chat, so it stops polling and a later visit starts fresh', () => {
    const before = chatStore(OLD);
    expect(chatStore(OLD)).toBe(before);
    dropChatStore(OLD);
    expect(chatStore(OLD)).not.toBe(before);
    dropChatStore(OLD);
  });

  it('reads a thread strictly, and keeps the list newest first as reads arrive', () => {
    expect(() => readThread({ ...thread(), thread_id: 'thr_x' })).toThrow();
    expect(() => readThread({ ...thread(), revision: 0 })).toThrow();
    const store = createThreadsStore(deps([]));
    store.seen(thread({ thread_id: OLD, last_activity_at: 1 }));
    store.seen(thread({ last_activity_at: 2 }));
    expect(store.get().threads.map(item => item.thread_id)).toEqual([ID, OLD]);
    store.seen(thread({ state: 'deleted' }));
    expect(store.get().threads.map(item => item.thread_id)).toEqual([OLD]);
  });
});
