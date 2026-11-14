// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatLink, ChatPanel } from './Chat';
import { ChatRequestError, ChatSignInRequired, type ChatMessage, type ChatPage, type ChatReceipt } from './chat-model';
import { createChatStore, type ChatDeps } from './chat-store';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
const deps = (page: () => Promise<ChatPage>, over: Partial<ChatDeps> = {}): ChatDeps => ({
  page, send: async () => ({ message_id: 'app-1', state: 'admitted', closed_reason: null, effects_unconfirmed: false } as ChatReceipt),
  receipt: async () => ({ message_id: 'app-1', state: 'running', closed_reason: null, effects_unconfirmed: false }), cancel: async () => ({ message_id: 'app-1', state: 'interrupted', closed_reason: 'cancelled', effects_unconfirmed: false }),
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

  it('draws the reply written so far where the reply will be, with the working line under it', async () => {
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
    expect(page.querySelector('.chat-msg.streaming .chat-draft')?.textContent).toBe('Here is the plan so far');
  });

  it('says what the turn is doing while its tools run, and gives way to the reply once it is written', async () => {
    const receipts = [
      { message_id: 'app-1', state: 'running' as const, closed_reason: null, effects_unconfirmed: false, activity: { kind: 'mail' as const, since: 1 } },
      { message_id: 'app-1', state: 'running' as const, closed_reason: null, effects_unconfirmed: false, draft: 'Two invoices', activity: { kind: 'mail' as const, since: 1 } },
    ];
    let next = 0;
    const store = createChatStore(deps(async () => ({ messages: [], next_cursor: null }), {
      send: async () => ({ message_id: 'app-1', state: 'running', closed_reason: null, effects_unconfirmed: false }),
      receipt: async () => receipts[Math.min(next++, receipts.length - 1)]!,
      setTimer: (run, ms) => window.setTimeout(run, ms), clearTimer: (id) => window.clearTimeout(id),
    }));
    const page = await mount(<ChatPanel zone="Asia/Kolkata" store={store}/>);
    const input = page.querySelector<HTMLTextAreaElement>('#chat-input')!;
    await type(input, 'Any invoices waiting on me?');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }); await flush();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); }); await flush();
    expect(page.querySelector('.chat-working')?.textContent).toContain('Checking your email…');
    await vi.waitFor(async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); }); expect(page.querySelector('.chat-msg.streaming .chat-draft')?.textContent).toBe('Two invoices'); }, { timeout: 5_000 });
    expect(page.querySelector('.chat-working')?.textContent).not.toContain('Checking your email…');
    expect(page.querySelector('.chat-working')?.textContent).toContain('Working on it');
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
describe('a reply streamed into the console', () => {
  const user: ChatMessage = { id: 'app-1', role: 'user', text: 'Plan my afternoon', parts: [], channel: 'app', parent_id: null, created_at: 1_760_000_000_000 };
  const reply = (text: string): ChatMessage => ({ id: 'r1', role: 'assistant', text, parts: [], channel: 'app', parent_id: 'app-1', created_at: 1_760_000_000_000 });
  const running = (draft: string): ChatReceipt => ({ message_id: 'app-1', state: 'running', closed_reason: null, effects_unconfirmed: false, draft });
  async function streaming(receipts: ChatReceipt[], pages: ChatMessage[][]) {
    let r = 0, p = 0;
    const store = createChatStore(deps(async () => ({ messages: pages[Math.min(p++, pages.length - 1)]!, next_cursor: null }), {
      send: async () => ({ message_id: 'app-1', state: 'running', closed_reason: null, effects_unconfirmed: false }),
      receipt: async () => receipts[Math.min(r++, receipts.length - 1)]!,
      setTimer: (run, ms) => window.setTimeout(run, ms), clearTimer: (id) => window.clearTimeout(id),
    }));
    const page = await mount(<ChatPanel zone="Asia/Kolkata" store={store}/>);
    await act(async () => { store.send('Plan my afternoon'); }); await flush();
    return page;
  }
  const wait = async (check: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); }); check(); }, { timeout: 6_000 });

  it('keeps the words being written out of the live log, so a screen reader hears the reply once it settles', async () => {
    const page = await streaming([running('Here is the plan')], [[]]);
    await wait(() => expect(page.querySelector('.chat-msg.streaming .chat-draft')?.textContent).toBe('Here is the plan'));
    expect(page.querySelector('.chat-msg.streaming .chat-draft')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('puts the reply in the words’ place without the arrival rise, fading in only what came after them', async () => {
    const page = await streaming(
      [running('Here is the plan'), { message_id: 'app-1', state: 'completed', closed_reason: null, effects_unconfirmed: false }],
      [[], [user, reply('Here is the plan for today.')]]);
    await wait(() => expect(page.querySelector('.chat-msg.waldo:not(.streaming) .chat-prose')?.textContent).toBe('Here is the plan for today.'));
    expect(page.querySelector('.chat-msg.streaming')).toBeNull();
    const settled = page.querySelector('.chat-msg.waldo:not(.streaming)')!;
    expect(settled.classList.contains('arrived')).toBe(false);
    expect([...settled.querySelectorAll('.word-in')].map(word => word.textContent)).toEqual(['for', 'today.']);
  });

  // The server closes a stopped turn as interrupted with the reason cancelled, whether it was stopped here or in the app.
  it('says the owner stopped it when a stop closes the turn, here or elsewhere, with no Ask again', async () => {
    const page = await streaming([running('Here is')], [[], [user]]);
    await wait(() => expect(page.querySelector('.composer-send.stop')).not.toBeNull());
    await act(async () => page.querySelector<HTMLButtonElement>('.composer-send.stop')!.click()); await flush();
    await wait(() => expect(page.querySelector('.chat-closure')?.textContent).toContain('You stopped this one.'));
    expect(page.querySelector('.chat-closure')?.textContent).not.toContain('didn’t finish');
    expect([...page.querySelectorAll('.chat-closure button')].map(button => button.textContent)).toEqual(['Dismiss']);
    const elsewhere = await streaming([running('Here is'), { message_id: 'app-1', state: 'interrupted', closed_reason: 'cancelled', effects_unconfirmed: true }], [[], [user]]);
    await wait(() => expect(elsewhere.querySelector('.chat-closure')?.textContent).toContain('You stopped this one. Something Waldo had already started may have happened.'));
  }, 15_000);

  it('keeps what an interrupted reply had shown, marked unfinished, beside the closure', async () => {
    const page = await streaming(
      [running('Here is'), { message_id: 'app-1', state: 'interrupted', closed_reason: 'interrupted', effects_unconfirmed: false }],
      [[], [user]]);
    await wait(() => expect(page.querySelector('.chat-closure')?.textContent).toContain('Waldo didn’t finish this one.'));
    expect(page.querySelector('.chat-unfinished .chat-prose')?.textContent).toBe('Here is');
    expect(page.querySelector('.chat-unfinished .chat-action')).toBeNull();
  });
});

// Attachments in the composer: picked, dropped or pasted; a chip with name, size and state; Send held until the server has the file.
describe('attaching a file in the console chat', () => {
  const UP = `up_${'A'.repeat(22)}`;
  const empty = async () => ({ messages: [], next_cursor: null });
  function attaching(over: Partial<ChatDeps> = {}) {
    const answers: ((result: { upload_id: string; bytes: number } | Error) => void)[] = [];
    const sent: [string, string | undefined][] = [];
    const store = createChatStore(deps(empty, {
      upload: () => new Promise((resolve, reject) => { answers.push(result => result instanceof Error ? reject(result) : resolve(result)); }),
      preview: file => `blob:${file.name}`, release: () => undefined, uploads: { served: 'unknown' },
      send: async (_id, text, uploadId) => { sent.push([text, uploadId]); return { message_id: 'app-1', state: 'admitted', closed_reason: null, effects_unconfirmed: false }; },
      ...over,
    }));
    return { store, answers, sent };
  }
  const pick = async (page: HTMLElement, files: File[]) => {
    const picker = page.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, 'files', { configurable: true, value: files });
    await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
  };
  const withData = (type: string, key: 'dataTransfer' | 'clipboardData', files: File[]) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, key, { value: { files, types: files.length ? ['Files'] : ['text/plain'], dropEffect: 'none' } });
    return event;
  };

  it('offers a labelled attach button that opens the file picker, from the keyboard too', async () => {
    const { store } = attaching();
    const page = await mount(<ChatPanel zone="UTC" store={store}/>);
    const button = page.querySelector<HTMLButtonElement>('button.composer-attach')!;
    expect(button.getAttribute('aria-label')).toBe('Attach a file or image');
    expect(button.disabled).toBe(false);
    const picker = page.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect([picker.tabIndex, picker.getAttribute('aria-hidden')]).toEqual([-1, 'true']);
    const opened = vi.fn();
    picker.addEventListener('click', opened);
    await act(async () => button.click());
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('shows the file’s name, size and upload state, holds Send while it uploads, and sends it with an empty caption', async () => {
    const { store, answers, sent } = attaching();
    const page = await mount(<ChatPanel zone="UTC" store={store}/>);
    await pick(page, [new File(['hello world'], 'notes.md', { type: '' })]);
    const chip = page.querySelector('.composer-attachment')!;
    expect(chip.getAttribute('aria-label')).toBe('Attachment, notes.md');
    expect(chip.textContent).toContain('notes.md');
    expect(chip.textContent).toContain('11 B · Uploading…');
    expect(page.querySelector('#chat-hint')?.textContent).toBe('Send is ready once the upload finishes');
    const send = () => page.querySelector<HTMLButtonElement>('.composer-send')!;
    expect([send().disabled, send().getAttribute('aria-label')]).toEqual([true, 'Send message with attachment']);
    expect(page.querySelector<HTMLButtonElement>('button.composer-attach')!.disabled).toBe(true);
    await act(async () => answers[0]!({ upload_id: UP, bytes: 11 })); await flush();
    expect(chip.textContent).toContain('Ready to send');
    expect(page.querySelector<HTMLTextAreaElement>('#chat-input')!.placeholder).toBe('Add a message (optional)');
    expect(send().disabled).toBe(false);
    await act(async () => send().click()); await flush();
    expect(sent).toEqual([['', UP]]);
    expect(page.querySelector('.composer-attachment')).toBeNull();
    const own = page.querySelector('.chat-msg.owner')!;
    expect(own.querySelector('.chat-attached-file')?.textContent).toBe('File you sent: notes.md11 B');
    expect(own.querySelector('.chat-bubble')).toBeNull();
  });

  it('takes a pasted image with a thumbnail, sends it with its caption, and draws the image you sent as a link to open it', async () => {
    const { store, answers, sent } = attaching();
    const page = await mount(<ChatPanel zone="UTC" store={store}/>);
    const input = page.querySelector<HTMLTextAreaElement>('#chat-input')!;
    const paste = withData('paste', 'clipboardData', [new File(['png'], 'image.png', { type: 'image/png' })]);
    await act(async () => { input.dispatchEvent(paste); }); await flush();
    expect(paste.defaultPrevented).toBe(true);
    expect(page.querySelector<HTMLImageElement>('.composer-thumb')?.getAttribute('src')).toBe('blob:image.png');
    await act(async () => answers[0]!({ upload_id: UP, bytes: 3 })); await flush();
    await type(input, 'Which of these is the receipt?');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }); await flush();
    expect(sent).toEqual([['Which of these is the receipt?', UP]]);
    const link = page.querySelector<HTMLAnchorElement>('.chat-msg.owner a.chat-attached-image')!;
    expect([link.getAttribute('href'), link.getAttribute('aria-label'), link.getAttribute('rel')]).toEqual(['blob:image.png', 'Open the image you sent, image.png', 'noopener noreferrer']);
    expect(page.querySelector('.chat-msg.owner .chat-bubble')?.textContent).toBe('Which of these is the receipt?');
  });

  it('leaves a plain text paste to the text box', async () => {
    const { store } = attaching();
    const page = await mount(<ChatPanel zone="UTC" store={store}/>);
    const paste = withData('paste', 'clipboardData', []);
    await act(async () => { page.querySelector('#chat-input')!.dispatchEvent(paste); }); await flush();
    expect([paste.defaultPrevented, page.querySelector('.composer-attachment')]).toEqual([false, null]);
  });

  it('takes a dropped file, saying so while it is dragged over the chat', async () => {
    const { store } = attaching();
    const page = await mount(<ChatPanel zone="UTC" store={store}/>);
    const chat = page.querySelector('.chat')!;
    const files = [new File(['%PDF-'], 'lease.pdf', { type: 'application/pdf' })];
    await act(async () => { chat.dispatchEvent(withData('dragenter', 'dataTransfer', files)); });
    expect(page.querySelector('.chat-drop')?.textContent).toContain('Drop a file or image to attach it');
    const dropped = withData('drop', 'dataTransfer', files);
    await act(async () => { chat.dispatchEvent(dropped); }); await flush();
    expect(dropped.defaultPrevented).toBe(true);
    expect(page.querySelector('.chat-drop')).toBeNull();
    expect(page.querySelector('.composer-attachment-name')?.textContent).toBe('lease.pdf');
  });

  it('says why an upload failed as an alert, offers Try again where it helps, and Remove returns focus to the text box', async () => {
    const { store, answers } = attaching();
    const page = await mount(<ChatPanel zone="UTC" store={store}/>);
    await pick(page, [new File(['x'], 'a.pdf', { type: 'application/pdf' })]);
    await act(async () => answers[0]!(new ChatRequestError(429, 'busy'))); await flush();
    expect(page.querySelector('.composer-attachment [role="alert"]')?.textContent).toMatch(/^Too many attachments/);
    expect(page.querySelector<HTMLButtonElement>('.composer-send')!.disabled).toBe(true);
    const retry = [...page.querySelectorAll<HTMLButtonElement>('.composer-attachment button')].find(button => button.textContent === 'Try again')!;
    await act(async () => retry.click()); await flush();
    expect(answers).toHaveLength(2);
    await act(async () => answers[1]!(new ChatRequestError(413, 'big'))); await flush();
    expect(page.querySelector('.composer-attachment [role="alert"]')?.textContent).toBe('That file is too big. The limit is 20 MB.');
    expect([...page.querySelectorAll('.composer-attachment button')].map(button => button.textContent)).toEqual(['×']);
    const remove = page.querySelector<HTMLButtonElement>('.composer-attachment-remove')!;
    expect(remove.getAttribute('aria-label')).toBe('Remove a.pdf');
    await act(async () => remove.click()); await flush();
    expect(page.querySelector('.composer-attachment')).toBeNull();
    expect(document.activeElement?.id).toBe('chat-input');
  });

  it('stops offering attachments once the server says it takes none, and never offers them without an upload route', async () => {
    const { store, answers } = attaching();
    const page = await mount(<ChatPanel zone="UTC" store={store}/>);
    await pick(page, [new File(['x'], 'a.pdf', { type: 'application/pdf' })]);
    await act(async () => answers[0]!(new ChatRequestError(404, 'off'))); await flush();
    expect(page.querySelector('.composer-attachment [role="alert"]')?.textContent).toBe('Waldo doesn’t take attachments here yet.');
    await act(async () => page.querySelector<HTMLButtonElement>('.composer-attachment-remove')!.click()); await flush();
    expect(page.querySelector('button.composer-attach')).toBeNull();
    const without = createChatStore(deps(empty));
    const plain = await mount(<ChatPanel zone="UTC" store={without}/>);
    expect([plain.querySelector('button.composer-attach'), plain.querySelector('input[type="file"]')]).toEqual([null, null]);
  });

  it('offers no attachment in an archived chat', async () => {
    const { store } = attaching();
    const page = await mount(<ChatPanel zone="UTC" store={store} locked={<p>Archived</p>}/>);
    expect(page.querySelector('button.composer-attach')).toBeNull();
    const dropped = withData('drop', 'dataTransfer', [new File(['x'], 'a.pdf')]);
    await act(async () => { page.querySelector('.chat')!.dispatchEvent(dropped); });
    expect(dropped.defaultPrevented).toBe(false);
  });
});
