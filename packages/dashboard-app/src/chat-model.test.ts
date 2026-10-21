import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatRequestError, ChatSignInRequired, fetchChatPage, readChatPage, readReceipt, sendChatMessage, visibleText, type ChatMessage } from './chat-model';

const row = (over: Record<string, unknown> = {}) => ({ id: 'app-1', role: 'assistant', text: 'Hello', parts: [{ type: 'text', text: 'Hello' }], channel: 'app', parent_id: 'app-0', created_at: 1_760_000_000_000, ...over });
afterEach(() => vi.unstubAllGlobals());

describe('reading the app chat page', () => {
  it('draws oldest first and keeps only the parts it can draw', () => {
    const page = readChatPage({ messages: [row({ id: 'b', parts: [{ type: 'text', text: 'x' }, { type: 'chart_series', title: 't' }, { type: 'quick_replies', choices: [{ id: 'y', label: 'Yes' }], fallback_text: 'Yes?' }] }), row({ id: 'a', role: 'user', created_at: undefined })], next_cursor: 'before:a' });
    expect(page.messages.map(m => m.id)).toEqual(['a', 'b']);
    expect(page.messages[0]!.created_at).toBeNull();
    expect(page.messages[1]!.parts).toEqual([{ type: 'quick_replies', choices: [{ id: 'y', label: 'Yes' }] }]);
    expect(page.next_cursor).toBe('before:a');
  });
  it('refuses a shape it cannot read rather than drawing part of it', () => {
    for (const bad of [null, { messages: 'x', next_cursor: null }, { messages: [row({ role: 'system' })], next_cursor: null }, { messages: [row({ text: 3 })], next_cursor: null }]) expect(() => readChatPage(bad)).toThrow(ChatRequestError);
  });
  it('reads a receipt, defaulting what an older server leaves out', () => {
    expect(readReceipt({ accepted: true, message_id: 'app-9', state: 'revoked', closed_reason: 'cancelled', effects_unconfirmed: true })).toEqual({ message_id: 'app-9', state: 'revoked', closed_reason: 'cancelled', effects_unconfirmed: true });
    expect(readReceipt({ accepted: true, message_id: 'app-9', state: 'running' })).toEqual({ message_id: 'app-9', state: 'running', closed_reason: null, effects_unconfirmed: false });
    expect(() => readReceipt({ accepted: true, message_id: 'app-9', state: 'done' })).toThrow();
  });
});

describe('the text a reply shows beside its parts', () => {
  const message = (text: string, parts: ChatMessage['parts']): ChatMessage => ({ id: 'm', role: 'assistant', text, parts, channel: 'app', parent_id: null, created_at: null });
  it('drops the receipt line the trace repeats', () => {
    expect(visibleText(message('Booked it.\n\nDone: 1 calendar change.', [{ type: 'receipt', items: [{ kind: 'calendar_change', target: 'Lunch', outcome: 'accepted', at: 1_760_000_000_000 }], more: 0, fallback_text: 'Done: 1 calendar change.' }]))).toBe('Booked it.');
  });
  it('shows nothing extra when the only words are the approval cards’ own', () => {
    const approval = { type: 'approval' as const, approval_id: 'a1', kind: 'email_send', review: 'To: x', question: null, expires_at: 1_760_000_000_000, fallback_text: 'Send the email to x?' };
    expect(visibleText(message('Send the email to x?', [approval]))).toBe('');
    expect(visibleText(message('Here is a draft.', [approval]))).toBe('Here is a draft.');
  });
});

describe('talking to the console chat route', () => {
  it('sends the app message shape with the console header, same-origin', async () => {
    const fetch = vi.fn(async () => Response.json({ accepted: true, message_id: 'app-5', state: 'admitted' }, { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    expect(await sendChatMessage('console-abcdefgh', 'Hi')).toMatchObject({ message_id: 'app-5', state: 'admitted' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/console/dashboard/api/v1/chat/messages');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect((init.headers as Record<string, string>)['x-waldo-console']).toBe('1');
    expect(JSON.parse(String(init.body))).toEqual({ client_message_id: 'console-abcdefgh', text: 'Hi' });
  });
  it('turns 401 into sign-in, 429 into a calm retry with its wait, and a network failure into status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await expect(fetchChatPage(null, 30)).rejects.toBeInstanceOf(ChatSignInRequired);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '60' } })));
    await expect(fetchChatPage(null, 30)).rejects.toMatchObject({ status: 429, retryAfter: 60 });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(fetchChatPage(null, 30)).rejects.toMatchObject({ status: 0 });
  });
});
