import { expect, it } from 'vitest';
import { sourceScopedMailLoops, type MailLoopSource } from '../src/channels/loops';
const source: MailLoopSource = { account_id: 'account-work', thread_id: 'thread-17', message_id: 'message-22', observed_at: 100,
  loop: { id: 'loop-1', title: 'Supplier requested a decision', due: '2026-10-10T12:00', status: 'open', created_at: 100, closed_at: null, source_ref: 'mail:account-work:thread-17' } };
const book = { sourceLinked: () => [source] };
const base = { ownerRef: 'prn_11111111222243338444555555555555', assertCurrent: async () => {},
  resolve: async () => ({ accountRef: source.account_id, threadRef: source.thread_id, messageRef: source.message_id, detail: 'Current read: sender asks about the order. No owner decision observed.' }) };
it('mail responsibility reaches context with exact account/source and unknown completion', async () => {
  const fragment = await sourceScopedMailLoops(book, base);
  expect(fragment?.source).toMatchObject({ source_kind: 'connector_snapshot', source_taint: 'external', scope: 'principal' });
  expect(fragment?.text).toContain('account-work');
  expect(fragment?.text).toContain('thread-17');
  expect(fragment?.text).toContain('"completion":"unknown"');
  expect(fragment?.text).toContain('"approval":"none"');
});
it('wrong account, changed source, held topics and unavailable source never reuse mail context', async () => {
  expect(await sourceScopedMailLoops(book, { ...base, resolve: async () => null })).toBeNull();
  expect(await sourceScopedMailLoops(book, { ...base, resolve: async () => ({ ...(await base.resolve()), accountRef: 'other-account' }) })).toBeNull();
  expect(await sourceScopedMailLoops(book, { ...base, resolve: async () => ({ ...(await base.resolve()), messageRef: 'new-message' }) })).toBeNull();
  expect(await sourceScopedMailLoops(book, { ...base, withhold: text => text.includes('Supplier') })).toBeNull();
});
it('revocation during source resolution is fenced before context publication', async () => {
  let revoked = false;
  await expect(sourceScopedMailLoops(book, { ...base, assertCurrent: async () => { if (revoked) throw new Error('revoked'); },
    resolve: async () => { revoked = true; return base.resolve(); } })).rejects.toThrow('revoked');
});
