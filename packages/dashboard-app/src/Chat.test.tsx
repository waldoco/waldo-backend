// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatLink, ChatPanel } from './Chat';
import { ChatSignInRequired, type ChatMessage, type ChatPage, type ChatReceipt } from './chat-model';
import { createChatStore, type ChatDeps } from './chat-store';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
const deps = (page: () => Promise<ChatPage>, over: Partial<ChatDeps> = {}): ChatDeps => ({
  page, send: async () => ({ message_id: 'app-1', state: 'admitted', closed_reason: null, effects_unconfirmed: false } as ChatReceipt),
  receipt: async () => ({ message_id: 'app-1', state: 'running', closed_reason: null, effects_unconfirmed: false }), cancel: async () => ({ message_id: 'app-1', state: 'revoked', closed_reason: 'cancelled', effects_unconfirmed: false }),
  id: () => 'console-client-1', now: () => 1_760_000_000_000, setTimer: () => 0, clearTimer: () => undefined, visible: () => true, ...over,
});
let root: Root | null = null, host: HTMLElement | null = null;
const mount = async (element: React.ReactElement) => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(element)); await flush();
  return host;
};
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; });
const type = async (el: HTMLTextAreaElement, value: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
};

describe('console chat page', () => {
  it('opens on a greeting with suggestions that fill the composer, not send', async () => {
    const sent: string[] = [];
    const store = createChatStore(deps(async () => ({ messages: [], next_cursor: null }), { send: async (_id, text) => { sent.push(text); return { message_id: 'app-1', state: 'admitted', closed_reason: null, effects_unconfirmed: false }; } }));
    const page = await mount(<ChatPanel zone="Asia/Kolkata" store={store}/>);
    expect(page.querySelector('.chat-greeting')?.textContent).toMatch(/^(Good (morning|afternoon|evening)|Hello)\.$/);
    const suggestion = page.querySelector<HTMLButtonElement>('.chat-suggestions button')!;
    await act(async () => suggestion.click());
    expect(page.querySelector<HTMLTextAreaElement>('#chat-input')!.value).toBe(suggestion.textContent);
    expect(sent).toEqual([]);
  });

  it('sends on Enter, keeps Shift+Enter for a new line, and shows Waldo working with a Stop', async () => {
    const sent: string[] = [];
    const store = createChatStore(deps(async () => ({ messages: [], next_cursor: null }), { send: async (_id, text) => { sent.push(text); return { message_id: 'app-1', state: 'admitted', closed_reason: null, effects_unconfirmed: false }; } }));
    const page = await mount(<ChatPanel zone="Asia/Kolkata" store={store}/>);
    const input = page.querySelector<HTMLTextAreaElement>('#chat-input')!;
    await type(input, 'Line one');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); });
    expect(sent).toEqual([]);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }); await flush();
    expect(sent).toEqual(['Line one']);
    expect(page.querySelector('.chat-msg.owner .chat-bubble')?.textContent).toBe('Line one');
    expect(page.querySelector('.chat-working')?.textContent).toContain('Waldo has your message');
    expect(page.querySelector('.composer-send.stop')).not.toBeNull();
    expect(page.querySelector('.chat-closure')).toBeNull();
    expect(page.querySelector('[role="log"]')?.getAttribute('aria-live')).toBe('polite');
  });

  it('draws the reply written so far inside the working row', async () => {
    const store = createChatStore(deps(async () => ({ messages: [], next_cursor: null }), {
      send: async () => ({ message_id: 'app-1', state: 'running', closed_reason: null, effects_unconfirmed: false }),
      receipt: async () => ({ message_id: 'app-1', state: 'running', closed_reason: null, effects_unconfirmed: false, draft: 'Here is **the plan** so far' }),
      setTimer: (run, ms) => window.setTimeout(run, ms), clearTimer: (id) => window.clearTimeout(id),
    }));
    const page = await mount(<ChatPanel zone="Asia/Kolkata" store={store}/>);
    const input = page.querySelector<HTMLTextAreaElement>('#chat-input')!;
    await type(input, 'Plan my afternoon');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }); await flush();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); }); await flush();
    expect(page.querySelector('.chat-msg.working .chat-draft')?.textContent).toBe('Here is the plan so far');
  });

  it('draws a reply with its trace, and quick replies only on the latest reply', async () => {
    const reply: ChatMessage = { id: 'r', role: 'assistant', text: 'Moved it.\n\nDone: 1 change.', channel: 'app', parent_id: 'app-1', created_at: 1_760_000_000_000,
      parts: [{ type: 'receipt', items: [{ kind: 'calendar_change', target: 'Standup', outcome: 'accepted', at: 1_760_000_000_000 }, { kind: 'email_send', target: null, outcome: 'failed', at: 1_760_000_000_000 }], more: 0, fallback_text: 'Done: 1 change.' }, { type: 'quick_replies', choices: [{ id: 'ok', label: 'Thanks' }] }] };
    const older: ChatMessage = { ...reply, id: 'r0', parts: [{ type: 'quick_replies', choices: [{ id: 'old', label: 'Old choice' }] }], text: 'Earlier.' };
    const store = createChatStore(deps(async () => ({ messages: [older, { id: 'u', role: 'user', text: 'Move standup', parts: [], channel: 'telegram', parent_id: null, created_at: 1_760_000_000_000 }, reply], next_cursor: null })));
    const page = await mount(<ChatPanel zone="Asia/Kolkata" store={store}/>);
    expect(page.textContent).toContain('Moved it.');
    expect(page.querySelector('.chat-prose')?.textContent).not.toContain('Done: 1 change.');
    expect(page.querySelector('.chat-trace summary')?.textContent).toContain('What Waldo did');
    expect(page.querySelector('.chat-trace summary')?.textContent).toContain('1 failed');
    expect([...page.querySelectorAll('.chat-replies button')].map(b => b.textContent)).toEqual(['Thanks']);
    expect(page.textContent).toContain('via Telegram');
    expect(page.querySelector('.chat-day')?.textContent).toBeTruthy();
  });

  it('holds back an over-long message and says how long it is', async () => {
    const store = createChatStore(deps(async () => ({ messages: [], next_cursor: null })));
    const page = await mount(<ChatPanel zone="UTC" store={store}/>);
    await type(page.querySelector<HTMLTextAreaElement>('#chat-input')!, 'x'.repeat(4001));
    expect(page.querySelector<HTMLButtonElement>('.composer-send')!.disabled).toBe(true);
    expect(page.querySelector('#chat-hint')?.textContent).toContain('4,001 / 4,000');
  });

  it('asks for sign-in when the session has ended', async () => {
    const store = createChatStore(deps(async () => { throw new ChatSignInRequired(); }));
    const page = await mount(<ChatPanel zone="UTC" store={store}/>);
    expect(page.querySelector('[role="alert"] h1')?.textContent).toBe('Sign in to chat with Waldo.');
    expect(page.querySelector('a[href="/console/signin"]')).not.toBeNull();
  });

  it('marks the top bar chat button while Waldo is working', async () => {
    const store = createChatStore(deps(async () => ({ messages: [], next_cursor: null })));
    const page = await mount(<><ChatLink current={false} store={store}/><ChatPanel zone="UTC" store={store}/></>);
    expect(page.querySelector('.chat-link-dot')).toBeNull();
    await act(async () => { store.send('Hi'); }); await flush();
    expect(page.querySelector('.chat-link-dot')).not.toBeNull();
    expect(page.querySelector('.chat-link')?.getAttribute('aria-label')).toBe('Chat with Waldo, Waldo is working');
  });
});
