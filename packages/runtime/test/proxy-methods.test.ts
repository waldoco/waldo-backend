import { describe, expect, it } from 'vitest';
import { PROXY_METHODS, PROXY_METHOD_FEATURE, validateProxyArgs } from '../src/connectors/proxy-methods';
import { googleHas } from '../src/connectors/google';

// The allowlist the runtime client and the Edge Function share: Tasks and the send-approval
// rail (sendRaw/findSentByMessageId) must pass both sides or they are not wired end-to-end.
describe('connector proxy method allowlist', () => {
  it('carries tasks, sendRaw and findSentByMessageId alongside the existing methods', () => {
    for (const method of ['tasks', 'sendRaw', 'findSentByMessageId', 'events', 'draft', 'newMail']) {
      expect(PROXY_METHODS).toContain(method);
    }
    expect(PROXY_METHODS).toHaveLength(11);
  });

  it('gates every method on the feature its grant must cover', () => {
    expect(PROXY_METHOD_FEATURE.tasks).toBe('tasks');
    expect(PROXY_METHOD_FEATURE.sendRaw).toBe('mail');
    expect(PROXY_METHOD_FEATURE.findSentByMessageId).toBe('mail');
    // a calendar-only grant cannot ride the send rail
    expect(googleHas(['https://www.googleapis.com/auth/calendar.events'], PROXY_METHOD_FEATURE.sendRaw)).toBe(false);
    expect(googleHas(['https://www.googleapis.com/auth/tasks'], 'tasks')).toBe(true);
  });

  it('bounds sendRaw payloads and rejects non-string or oversize raw bytes', () => {
    expect(validateProxyArgs('sendRaw', ['To: a@b.test\r\n\r\nhi'])).toBeNull();
    expect(validateProxyArgs('sendRaw', ['x'.repeat(1_000_001)])).toBe('sendRaw needs bounded raw MIME bytes');
    expect(validateProxyArgs('sendRaw', [123])).toBe('sendRaw needs bounded raw MIME bytes');
    expect(validateProxyArgs('sendRaw', ['ok', 'x'.repeat(513)])).toBe('sendRaw thread id must be a short string');
    expect(validateProxyArgs('sendRaw', ['ok', 't-1'])).toBeNull();
  });

  it('bounds findSentByMessageId and tasks args', () => {
    expect(validateProxyArgs('findSentByMessageId', ['<m@waldo-send>'])).toBeNull();
    expect(validateProxyArgs('findSentByMessageId', ['x'.repeat(513)])).not.toBeNull();
    expect(validateProxyArgs('findSentByMessageId', [{}])).not.toBeNull();
    expect(validateProxyArgs('tasks', ['todo', 20])).toBeNull();
    expect(validateProxyArgs('tasks', ['everything', 20])).toBe('tasks needs a known status filter');
    expect(validateProxyArgs('tasks', ['todo', 0])).toBe('tasks limit must be an integer 1..100');
    expect(validateProxyArgs('tasks', ['todo', 101])).toBe('tasks limit must be an integer 1..100');
    expect(validateProxyArgs('tasks', ['all', 100])).toBeNull();
  });

  it('bounds the generic args envelope and the args shape', () => {
    expect(validateProxyArgs('events', 'nope')).toBe('args must be an array');
    expect(validateProxyArgs('events', ['x'.repeat(2_000_001)])).toBe('args too large');
    expect(validateProxyArgs('events', ['a', 'b', 1, false])).toBeNull();
  });
});
