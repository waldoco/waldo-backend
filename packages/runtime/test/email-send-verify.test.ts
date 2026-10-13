import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { ProxyIntentError } from '../src/connectors/proxy-intent';
import { GoogleError, GoogleTokenError, googleClient, sha256Hex, type GoogleClient } from '../src/connectors/google';

// Synthetic mail only. An approved send is Sent only on Gmail metadata with SENT, our exact Message-ID
// and the intended thread; these tests separate a send that landed but was not yet searchable, a
// Message-ID Gmail rewrote, and a send Gmail refused before anything went out.
const MESSAGE_ID = '<fixture@waldo-send>';
const sentEvidence = (overrides: Record<string, unknown> = {}) => ({ message_id: 'g1', thread_id: 't1', rfc822_message_id: MESSAGE_ID, label_ids: ['SENT'], ...overrides });
type Hop = Readonly<{ hop: string; ok?: boolean; code?: string; error?: string }>;

const approve = async (name: string, client: Partial<GoogleClient>, withLedger = true, threadId?: string) => {
  let result!: { toast: string; message: string };
  const hops: Hop[] = [];
  let ledgerState: string | undefined;
  let status: string | undefined;
  let waits = 0;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const effects = withLedger ? ownerEffectLedger(state.storage, () => 1000) : undefined;
    const desk = approvalDesk(state.storage.sql, { owner: 42, call: async () => ({}), google: async () => client as GoogleClient, newId: () => 'one', now: () => 1000, timezone: 'UTC', log: (entry: Hop) => { hops.push(entry); }, wait: async () => { waits++; }, ...(effects ? { effects } : {}) });
    const raw = 'approved bytes';
    const id = await desk.proposeSendEmail({ to: ['friend@example.test'], subject: 'Hi', body: 'Hello', raw, digest: await sha256Hex(raw), message_id: MESSAGE_ID, ...(threadId ? { thread_id: threadId } : {}) });
    result = await desk.decide(id, 'a', 'test');
    ledgerState = effects?.get(`approval:${id}:apply`)?.state;
    status = state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  });
  const codes = hops.filter(h => h.hop.startsWith('email_')).map(h => `${h.hop}:${h.code}`);
  return { result, hops, codes, ledgerState, status, waits };
};
const sends = (outcome: () => Promise<unknown>) => ({ sendRaw: outcome as GoogleClient['sendRaw'] });

describe('an approved send that landed', () => {
  it('is Sent from the metadata of the id Gmail returned, even before Gmail search can find it', async () => {
    const { result, codes, ledgerState } = await approve('send-verify-by-id', {
      ...sends(async () => ({ message_id: 'g1', thread_id: 't1' })),
      // A search right after the send can miss; a read by the returned id cannot.
      findSentByMessageId: (async (_messageId: string, _threadId?: string, sentId?: string) => sentId === 'g1' ? sentEvidence() : false) as GoogleClient['findSentByMessageId'],
    });
    expect(result.toast).toBe('Sent');
    expect(ledgerState).toBe('done');
    expect(codes).toEqual(['email_thread:no_thread', 'email_send:sent', 'email_verify:verified']);
  });

  it('stays unknown on a proxy that can only search, and logs whether the thread holds our exact Message-ID', async () => {
    const thread = (messageId: string) => ({ threadPage: (async (threadId: string) => ({ messages: threadId === 't1' ? [{ id: 'g0', message_id: '<earlier@example.test>' }, { id: 'g1', message_id: messageId }] : [], cursor: null })) as unknown as GoogleClient['threadPage'] });
    const lagging = await approve('send-verify-lag', { ...sends(async () => ({ message_id: 'g1', thread_id: 't1' })), findSentByMessageId: (async () => false) as GoogleClient['findSentByMessageId'], ...thread(MESSAGE_ID) });
    expect(lagging.result.toast).toBe('Outcome unknown');
    expect(lagging.status).toBe('uncertain');
    expect(lagging.codes).toEqual(['email_thread:no_thread', 'email_send:sent', 'email_verify:not_found', 'email_verify:not_found', 'email_verify:not_found', 'email_diagnose:header_matches', 'email_reconcile:not_found']);
    expect(lagging.waits).toBe(2);
    const rewritten = await approve('send-verify-rewritten', { ...sends(async () => ({ message_id: 'g1', thread_id: 't1' })), findSentByMessageId: (async () => false) as GoogleClient['findSentByMessageId'], ...thread('<CArewritten@mail.gmail.com>') });
    expect(rewritten.codes).toContain('email_diagnose:header_differs');
  });

  it('logs whether Gmail kept the send in the proposal\'s thread, so a miss tells lag from another thread', async () => {
    const missing = { findSentByMessageId: (async () => false) as GoogleClient['findSentByMessageId'] };
    const other = await approve('send-verify-other-thread', { ...sends(async () => ({ message_id: 'g1', thread_id: 't2' })), ...missing }, true, 't1');
    expect(other.codes.slice(0, 3)).toEqual(['email_thread:thread_set', 'email_send:sent', 'email_thread_match:other_thread']);
    const same = await approve('send-verify-same-thread', { ...sends(async () => ({ message_id: 'g1', thread_id: 't1' })), ...missing }, true, 't1');
    expect(same.codes.slice(0, 3)).toEqual(['email_thread:thread_set', 'email_send:sent', 'email_thread_match:same_thread']);
    for (const hop of [...other.hops, ...same.hops].filter(h => h.hop === 'email_thread_match')) expect(Object.keys(hop).sort()).toEqual(['code', 'hop', 'ms', 'ok', 'trace']);
  });

  it('is Sent when a search that trailed the send finds it on a retry', async () => {
    let searches = 0;
    const { result, codes, waits } = await approve('send-verify-catch-up', { ...sends(async () => ({ message_id: 'g1', thread_id: 't1' })), findSentByMessageId: (async () => ++searches < 3 ? false : sentEvidence()) as GoogleClient['findSentByMessageId'] });
    expect(result.toast).toBe('Sent');
    expect(codes).toEqual(['email_thread:no_thread', 'email_send:sent', 'email_verify:not_found', 'email_verify:not_found', 'email_verify:verified']);
    expect(waits).toBe(2);
  });

  it('names the check that failed when the returned id does not verify', async () => {
    for (const [overrides, code] of [[{ label_ids: ['DRAFT'] }, 'not_sent_label'], [{ rfc822_message_id: '<other@example.test>' }, 'rfc822_mismatch'], [{ message_id: 'g2' }, 'id_mismatch']] as const) {
      const { codes, status } = await approve(`send-verify-${code}`, { ...sends(async () => ({ message_id: 'g1', thread_id: 't1' })), findSentByMessageId: (async (_m: string, _t?: string, sentId?: string) => sentId ? sentEvidence(overrides) : false) as GoogleClient['findSentByMessageId'] });
      expect(status).toBe('uncertain');
      expect(codes).toEqual(['email_thread:no_thread', 'email_send:sent', `email_verify:${code}`, `email_reconcile:${code}`]);
    }
  });
});

describe('an approved send that Gmail refused', () => {
  it('is not sent, never unknown, when Gmail refuses before sending or the token fails first', async () => {
    for (const [status, error] of [...[400, 401, 403, 429].map(code => [code, new GoogleError(code, `google ${code}: synthetic refusal`)] as const), ['token', new GoogleTokenError('auth')] as const, ['token-config', new GoogleTokenError('configuration')] as const]) {
      const refused = await approve(`send-refused-${status}`, { ...sends(async () => { throw error; }), findSentByMessageId: (async () => false) as GoogleClient['findSentByMessageId'] });
      expect(refused.status).toBe('failed');
      expect(refused.ledgerState).toBe('rejected');
      expect(refused.result.toast).toBe('Not sent');
      expect(refused.result.message).not.toContain('synthetic refusal');
      expect(refused.codes).toEqual(['email_thread:no_thread', 'email_send:refused', 'email_reconcile:not_found']);
    }
  });

  it('is Sent when a refusal still left a verified Sent copy', async () => {
    const { result, ledgerState } = await approve('send-refused-landed', { ...sends(async () => { throw new GoogleError(400, 'google 400: synthetic'); }), findSentByMessageId: (async () => sentEvidence()) as GoogleClient['findSentByMessageId'] });
    expect(result.toast).toBe('Sent');
    expect(ledgerState).toBe('done');
  });

  it('stays unknown after a server error, a lost response or a proxy intent state', async () => {
    for (const [name, error] of [['5xx', new GoogleError(503, 'google 503: synthetic')], ['proxy-5xx', new GoogleError(502, 'connector proxy failed')], ['lost', new TypeError('network connection lost')], ['intent', new ProxyIntentError('intent_unavailable')]] as const) {
      const { status, codes } = await approve(`send-unknown-${name}`, { ...sends(async () => { throw error; }), findSentByMessageId: (async () => false) as GoogleClient['findSentByMessageId'] });
      expect(status).toBe('uncertain');
      expect(codes[1]).toBe('email_send:unknown');
    }
  });

  it('is not sent without an effect ledger too', async () => {
    const { status, result } = await approve('send-refused-no-ledger', { ...sends(async () => { throw new GoogleError(401, 'google 401: synthetic'); }), findSentByMessageId: (async () => false) as GoogleClient['findSentByMessageId'] }, false);
    expect(status).toBe('failed');
    expect(result.toast).toBe('Not sent');
  });
});

describe('send hops', () => {
  it('carry fixed codes only: no address, Message-ID or provider error text', async () => {
    const all: Hop[] = [];
    for (const client of [
      { ...sends(async () => { throw new GoogleError(403, 'google 403: synthetic refusal for friend@example.test'); }), findSentByMessageId: (async () => { throw new GoogleError(500, `google 500: ${MESSAGE_ID}`); }) as GoogleClient['findSentByMessageId'] },
      { ...sends(async () => ({ message_id: 'g1', thread_id: 't1' })), findSentByMessageId: (async () => false) as GoogleClient['findSentByMessageId'], threadPage: (async () => { throw new GoogleError(500, 'google 500: friend@example.test'); }) as unknown as GoogleClient['threadPage'] },
    ]) all.push(...(await approve(`send-hops-${all.length}`, client)).hops);
    const emailHops = all.filter(h => h.hop.startsWith('email_'));
    expect(emailHops.length).toBeGreaterThan(3);
    for (const hop of emailHops) expect(Object.keys(hop).sort()).toEqual(['code', 'hop', 'ms', 'ok', 'trace']);
    const text = JSON.stringify(all);
    for (const leaked of ['friend@example.test', 'fixture@waldo-send', 'synthetic refusal', 'google 500']) expect(text).not.toContain(leaked);
  });
});

describe('the connector read by the returned id', () => {
  const gmail = (urls: string[]) => googleClient({ clientId: 'c', clientSecret: 's', redirectUri: 'https://example.invalid' }, { refresh_token: 'r' }, (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('oauth2')) return Response.json({ access_token: 'a' });
    if (url.includes('/messages?')) return Response.json({ messages: [{ id: 'g1' }] });
    return Response.json({ id: 'g1', threadId: 't1', labelIds: ['DRAFT'], payload: { headers: [{ name: 'Message-ID', value: MESSAGE_ID }] } });
  }) as typeof fetch);

  it('reads that message metadata directly, never searching, and returns it for the caller to check', async () => {
    const urls: string[] = [];
    expect(await gmail(urls).findSentByMessageId(MESSAGE_ID, undefined, 'g1')).toEqual(sentEvidence({ label_ids: ['DRAFT'] }));
    expect(urls.some(url => url.includes('/messages?'))).toBe(false);
    expect(urls.some(url => url.includes('/messages/g1?format=metadata'))).toBe(true);
  });

  it('still searches when no id is given, and still returns only verified Sent evidence there', async () => {
    const urls: string[] = [];
    expect(await gmail(urls).findSentByMessageId(MESSAGE_ID)).toBe(false);
    expect(urls.some(url => url.includes('/messages?'))).toBe(true);
  });
});
