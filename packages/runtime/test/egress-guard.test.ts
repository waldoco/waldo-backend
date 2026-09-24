import { describe, expect, it, vi } from 'vitest';
import { egressGuardedCaller, redactSecretUrls } from '../src/channels/egress-guard';

describe('redactSecretUrls (narrow scope)', () => {
  it('redacts a Google consent URL', () => {
    const r = redactSecretUrls('go here https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y to connect');
    expect(r.count).toBe(1);
    expect(r.text).toBe('go here [link removed] to connect');
  });
  it('redacts a first-party /c/ ticket link', () => {
    const r = redactSecretUrls('https://waldo.piyushfulper3210.workers.dev/c/AbCdEfGhIjKlMnOpQrStUv');
    expect(r.count).toBe(1);
    expect(r.text).toBe('[link removed]');
  });
  it('redacts an /oauth/ callback URL and a URL carrying state/code keys', () => {
    expect(redactSecretUrls('https://waldo.example/oauth/google/callback?code=4/0abc&state=zz').count).toBe(1);
    expect(redactSecretUrls('https://anything.example/page?code_challenge=xyz').count).toBe(1);
  });
  it('leaves ordinary links alone, including third-party signed URLs', () => {
    const s3 = 'https://bucket.s3.amazonaws.com/report.pdf?X-Amz-Signature=abc123&X-Amz-Expires=3600';
    expect(redactSecretUrls(s3).text).toBe(s3);
    expect(redactSecretUrls('see https://docs.google.com/document/d/1abc/edit and https://example.com?a=b').count).toBe(0);
    expect(redactSecretUrls('no links here').count).toBe(0);
  });
});

describe('egressGuardedCaller', () => {
  it('redacts sendMessage text before it leaves and reports the count', async () => {
    const call = vi.fn(async () => ({}));
    const onRedact = vi.fn();
    const guarded = egressGuardedCaller(call, onRedact);
    await guarded('sendMessage', { chat_id: 1, text: 'tap https://accounts.google.com/o/oauth2/v2/auth?state=x now' });
    expect(call).toHaveBeenCalledWith('sendMessage', { chat_id: 1, text: 'tap [link removed] now' });
    expect(onRedact).toHaveBeenCalledWith(1, 'sendMessage');
  });
  it('leaves clean text and other methods untouched', async () => {
    const call = vi.fn(async () => ({}));
    const onRedact = vi.fn();
    const guarded = egressGuardedCaller(call, onRedact);
    await guarded('sendMessage', { chat_id: 1, text: 'hello, no links' });
    await guarded('setMessageReaction', { chat_id: 1, message_id: 2, reaction: [] });
    expect(call).toHaveBeenNthCalledWith(1, 'sendMessage', { chat_id: 1, text: 'hello, no links' });
    expect(call).toHaveBeenNthCalledWith(2, 'setMessageReaction', { chat_id: 1, message_id: 2, reaction: [] });
    expect(onRedact).not.toHaveBeenCalled();
  });
});
