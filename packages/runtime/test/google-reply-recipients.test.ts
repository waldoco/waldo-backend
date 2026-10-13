import { describe, expect, it } from 'vitest';
import { addressList, googleClient, type GoogleClient } from '../src/connectors/google';
import { googleHandlers, type GoogleAccess } from '../src/tools/live/google';

const app = { clientId: 'c', clientSecret: 's', redirectUri: 'https://w.test/oauth/google/callback' };
const b64 = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('address lists from mail headers', () => {
  it('keeps only the addresses, through display names, quoted commas and groups', () => {
    expect(addressList('"Lee, Sam" <sam@example.com>, pat@example.org, Ana <ANA@Example.com>')).toEqual(['sam@example.com', 'pat@example.org', 'ANA@Example.com']);
    expect(addressList('Team: a@example.com, b@example.com;, c@example.com')).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    expect(addressList('undisclosed-recipients:;')).toEqual([]);
    expect(addressList('')).toEqual([]);
  });
  it('drops what is not an address and caps the list', () => {
    expect(addressList('not an address, <also bad>, "x" <ok@example.com>')).toEqual(['ok@example.com']);
    expect(addressList(Array.from({ length: 80 }, (_, i) => `u${i}@example.com`).join(', '))).toHaveLength(50);
  });
});

const threadFetch = (async (input: RequestInfo | URL) => {
  if (String(input).startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at' });
  return Response.json({ id: 't1', messages: [{ id: 'm1', threadId: 't1', internalDate: '1759140000000', payload: { mimeType: 'text/plain', body: { data: b64('Can we meet Thursday?') }, headers: [
    { name: 'From', value: 'Sam Lee <sam@example.com>' }, { name: 'To', value: 'Owner <owner@example.com>, "Pat, PM" <pat@example.org>' },
    { name: 'Cc', value: 'ana@example.com' }, { name: 'Reply-To', value: 'team@example.com' }, { name: 'Subject', value: 'Plans' },
    { name: 'Message-ID', value: '<m1@example.com>' },
  ] } }] });
}) as typeof fetch;

describe('reading a thread shows who is on it', () => {
  it('each message carries its to, cc and reply-to addresses', async () => {
    const page = await googleClient(app, { refresh_token: 'rt' }, threadFetch).threadPage!('t1', 10);
    expect(page.messages[0]).toMatchObject({ from: 'Sam Lee <sam@example.com>', to: ['owner@example.com', 'pat@example.org'], cc: ['ana@example.com'], reply_to: ['team@example.com'] });
  });

  it('read_thread hands them to the model with the owner\'s own address, and tells it how to reply to all', async () => {
    const client = { ...googleClient(app, { refresh_token: 'rt' }, threadFetch), account: { connection_id: 'local:owner@example.com', email: 'owner@example.com' } } as GoogleClient;
    const access = { client: async () => client, state: async () => [{ mail: true }] } as unknown as GoogleAccess;
    const handlers = googleHandlers(access, { record: () => undefined } as never, { now: () => new Date(), timezone: 'UTC' } as never);
    const read = handlers.find((h) => h.name === 'read_thread')!;
    const result = await read.handle({ thread_id: 't1', limit: 10 } as never);
    expect(result).toMatchObject({ ok: true, data: { account: { email: 'owner@example.com' }, messages: [{ to: ['owner@example.com', 'pat@example.org'], cc: ['ana@example.com'], reply_to: ['team@example.com'] }] } });
    for (const name of ['read_thread', 'draft_email', 'send_email']) expect(handlers.find((h) => h.name === name)!.description).toMatch(/reply to all/i);
  });
});
