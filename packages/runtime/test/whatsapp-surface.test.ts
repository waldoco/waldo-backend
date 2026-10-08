import { describe, expect, it, vi } from 'vitest';
import { createWhatsAppSurfaceAdapter, whatsappSelection } from '../src/channels/surfaces/whatsapp';
import type { RunEffectScope } from '../src/channels/run-effect-scope';

const scope: RunEffectScope = { runId: 'run', attempt: 'one', deadline: 100, signal: new AbortController().signal, admit() {}, commit: work => work() };
const message = { id: 'wamid.in', from: '15551234', type: 'text', text: { body: 'Hello' } };
function fixture() {
  const call = vi.fn(async (_body: object): Promise<unknown> => ({ messages: [{ id: `wamid.out-${call.mock.calls.length}` }] }));
  const adapter = createWhatsAppSurfaceAdapter({ call, recipient: '15551234', conversationRef: 'opaque-wa-ref' });
  return { call, adapter };
}
const input = () => ({ message, traceId: 'host-trace', runScope: scope });

describe('native WhatsApp surface adapter', () => {
  it('normalizes admitted text with native presentation and host-owned scope/identity', () => {
    const { adapter } = fixture();
    expect(adapter.toEnvelope(input())).toMatchObject({ surface: 'whatsapp', traceId: 'host-trace', conversationRef: 'opaque-wa-ref', text: 'Hello', runScope: scope, messageRef: { id: 'wamid.in', conversationRef: 'opaque-wa-ref' }, presentation: { delivery: { approval: 'native_buttons', attachments: true }, commands: [] } });
    expect(adapter.limits).toMatchObject({ textMax: 4096, buttons: 3, attachmentsOut: true });
  });
  it('rejects foreign senders without a numeric identity cast', () => {
    const { adapter } = fixture();
    expect(() => adapter.toEnvelope({ ...input(), message: { ...message, from: 'foreign' } })).toThrow('sender');
  });
  it('carries host-resolved images and voice into the common envelope', () => {
    const { adapter } = fixture();
    const attachments = [{ kind: 'image' as const, mime_type: 'image/png', filename: 'photo.png', data_base64: 'aGVsbG8=' }];
    const image = adapter.toEnvelope({ ...input(), message: { ...message, type: 'image', image: { id: 'media', caption: 'Look' } }, attachments });
    expect(image).toMatchObject({ text: 'Look', attachments, runScope: scope });
    expect(adapter.toEnvelope({ ...input(), message: { ...message, type: 'audio', audio: { id: 'voice' } }, transcript: 'spoken words', mediaNote: 'Voice transcribed' })).toMatchObject({ text: 'spoken words', mediaNote: 'Voice transcribed', runScope: scope });
    expect(() => adapter.toEnvelope({ ...input(), message: { ...message, type: 'audio', audio: { id: 'voice' } } })).toThrow('resolved');
  });
  it.each(['button_reply', 'list_reply'] as const)('decodes %s selection id without interpreting its display title as an instruction', type => {
    expect(whatsappSelection({ ...message, type: 'interactive', interactive: { type, [type]: { id: 'a:proposal', title: 'untrusted label' } } })).toEqual({ id: 'a:proposal', messageId: 'wamid.in' });
  });
  it('sends long text sequentially with the shared splitter and keeps provider receipts', async () => {
    const { call, adapter } = fixture();
    const text = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`;
    expect(await adapter.render('opaque-wa-ref', { kind: 'reply', text })).toEqual([{ providerMessageId: 'wamid.out-1' }, { providerMessageId: 'wamid.out-2' }]);
    expect(call.mock.calls.map(([body]) => body)).toEqual([{ to: '15551234', type: 'text', text: { body: 'a'.repeat(3000) } }, { to: '15551234', type: 'text', text: { body: 'b'.repeat(3000) } }]);
  });
  it('waits for the first acknowledgement before dispatching the next part', async () => {
    const { call, adapter } = fixture();
    let resolve!: (value: unknown) => void;
    call.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const result = adapter.render('opaque-wa-ref', { kind: 'reply', text: 'a'.repeat(5000) });
    expect(call).toHaveBeenCalledTimes(1);
    resolve({ messages: [{ id: 'first' }] });
    expect(await result).toHaveLength(2);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('renders approval choices as native buttons, never a reply-code suffix', async () => {
    const { call, adapter } = fixture();
    await adapter.render('opaque-wa-ref', { kind: 'card', text: 'Send this?', choices: [{ id: 'a:p1', title: 'Send it' }, { id: 'e:p1', title: 'Modify' }] });
    expect(call).toHaveBeenCalledWith({ to: '15551234', type: 'interactive', interactive: { type: 'button', body: { text: 'Send this?' }, action: { buttons: [{ type: 'reply', reply: { id: 'a:p1', title: 'Send it' } }, { type: 'reply', reply: { id: 'e:p1', title: 'Modify' } }] } } });
  });
  it('renders four or more choices as a native list', async () => {
    const { call, adapter } = fixture();
    const choices = Array.from({ length: 4 }, (_, i) => ({ id: `pick:${i}`, title: `Choice ${i}` }));
    await adapter.render('opaque-wa-ref', { kind: 'card', text: 'Choose', choices, listTitle: 'Options' });
    expect(call).toHaveBeenCalledWith({ to: '15551234', type: 'interactive', interactive: { type: 'list', body: { text: 'Choose' }, action: { button: 'Options', sections: [{ rows: choices }] } } });
  });
  it('splits a long card before its interactive tail without duplicating choices', async () => {
    const { call, adapter } = fixture();
    await adapter.render('opaque-wa-ref', { kind: 'card', text: 'a'.repeat(1500), choices: [{ id: 'yes', title: 'Yes' }] });
    expect(call.mock.calls).toHaveLength(2);
    expect(call.mock.calls[0]![0]).toMatchObject({ type: 'text', text: { body: 'a'.repeat(1024) } });
    expect(call.mock.calls[1]![0]).toMatchObject({ type: 'interactive', interactive: { body: { text: 'a'.repeat(476) } } });
  });
  it('rejects invalid card choices before any send; no silent truncation', async () => {
    const { call, adapter } = fixture();
    await expect(adapter.render('opaque-wa-ref', { kind: 'card', text: 'a'.repeat(5000), choices: [{ id: 'yes', title: 'x'.repeat(25) }] })).rejects.toThrow('title');
    await expect(adapter.render('opaque-wa-ref', { kind: 'card', text: 'Pick', choices: [{ id: 'same', title: 'Yes' }, { id: 'same', title: 'No' }] })).rejects.toThrow('duplicate');
    expect(call).not.toHaveBeenCalled();
  });
  it('renders a host-approved document without a Telegram operation', async () => {
    const { call, adapter } = fixture();
    await adapter.render('opaque-wa-ref', { kind: 'file', mediaId: 'media-id', filename: 'notes.pdf' });
    expect(call).toHaveBeenCalledWith({ to: '15551234', type: 'document', document: { id: 'media-id', filename: 'notes.pdf' } });
  });
  it('rejects empty text and unsupported operations without sending', async () => {
    const { call, adapter } = fixture();
    await expect(adapter.render('opaque-wa-ref', { kind: 'reply', text: '' })).rejects.toThrow('reply text');
    await expect(adapter.render('opaque-wa-ref', { kind: 'reaction' } as never)).rejects.toThrow('unsupported');
    expect(call).not.toHaveBeenCalled();
  });
  it('does not send to a mismatched conversation', async () => {
    const { call, adapter } = fixture();
    await expect(adapter.render('wrong', { kind: 'reply', text: 'hello' })).rejects.toThrow('conversation');
    expect(call).not.toHaveBeenCalled();
  });
  it('stops on an uncertain send, never retries or sends the following part', async () => {
    const { call, adapter } = fixture();
    call.mockRejectedValueOnce(new Error('uncertain'));
    await expect(adapter.render('opaque-wa-ref', { kind: 'reply', text: 'x'.repeat(9000) })).rejects.toThrow('uncertain');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('reports acknowledged parts to Core when a later part becomes uncertain', async () => {
    const { call, adapter } = fixture();
    call.mockImplementationOnce(async () => ({ messages: [{ id: 'first' }] })).mockRejectedValueOnce(new Error('timeout'));
    await expect(adapter.render('opaque-wa-ref', { kind: 'reply', text: 'x'.repeat(9000) })).rejects.toMatchObject({ receipts: [{ providerMessageId: 'first' }], failedPart: 1 });
    expect(call).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, {}, { messages: [] }, { messages: [{ id: '' }] }])('treats malformed acknowledgement %j as uncertain', async ack => {
    const { call, adapter } = fixture();
    call.mockResolvedValueOnce(ack);
    await expect(adapter.render('opaque-wa-ref', { kind: 'reply', text: 'Hello' })).rejects.toThrow('acknowledgement');
    expect(call).toHaveBeenCalledTimes(1);
  });
});
