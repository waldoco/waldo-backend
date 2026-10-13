import { describe, expect, it } from 'vitest';
import { GOOGLE_CONSENT_SCOPES, GOOGLE_FEATURE_SCOPES, GOOGLE_METHODS, GoogleError, googleClient, googleHas, type ContactMatch } from '../src/connectors/google';
import { buildSessionState } from '@waldo/contracts';
import { dispatchTool } from '../src/tools/dispatcher';
import { sanitise } from '../src/scribe/sanitiser';
import { googleHandlers } from '../src/tools/live/google';

const AUTH = 'https://www.googleapis.com/auth/';
const app = { clientId: 'fictional-client', clientSecret: 'fictional-secret', redirectUri: 'https://example.test/cb' };
const person = (name: string | null, ...emails: string[]) => ({ person: { ...(name ? { names: [{ displayName: name }] } : {}), emailAddresses: emails.map((value) => ({ value })) } });
const people = (saved: unknown[], other: unknown[]) => {
  const calls: URL[] = [];
  const fetcher = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.origin === 'https://oauth2.googleapis.com') return Response.json({ access_token: 'fictional-access', expires_in: 3600 });
    calls.push(url);
    const results = url.searchParams.get('query') === '' ? [] : url.pathname === '/v1/people:searchContacts' ? saved : other;
    return Response.json({ results });
  };
  return { calls, client: googleClient(app, { refresh_token: 'fictional-refresh' }, fetcher as typeof fetch) };
};
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-10-13T10:00:00+05:30') };
const desk = { propose: async () => { throw new Error('no effect'); }, proposeSendEmail: async () => { throw new Error('no effect'); }, record: () => { throw new Error('no effect'); } };
const tool = (client: unknown) => googleHandlers({ client: async () => client as never }, desk, clock).find((handler) => handler.name === 'search_contacts')!;

describe('Google contacts lookup', () => {
  it('asks for both read-only contact scopes in the one consent, and never reads a legacy grant as holding them', () => {
    expect(GOOGLE_FEATURE_SCOPES.contacts).toEqual([`${AUTH}contacts.readonly`, `${AUTH}contacts.other.readonly`]);
    expect(GOOGLE_CONSENT_SCOPES).toEqual(expect.arrayContaining([...GOOGLE_FEATURE_SCOPES.contacts]));
    expect(googleHas(null, 'contacts')).toBe(false);
    expect(googleHas([`${AUTH}contacts.readonly`], 'contacts')).toBe(false);
    expect(googleHas(GOOGLE_FEATURE_SCOPES.contacts, 'contacts')).toBe(true);
    expect(GOOGLE_METHODS).toContain('searchContacts');
  });

  it('warms each People cache with an empty query, then searches names and addresses only', async () => {
    const { client, calls } = people([person('Priya Nair', 'priya@northwind.example')], []);
    await client.searchContacts!('Priya', 5);
    for (const path of ['/v1/people:searchContacts', '/v1/otherContacts:search']) {
      const sent = calls.filter((url) => url.pathname === path);
      expect(sent.map((url) => url.searchParams.get('query'))).toEqual(['', 'Priya']);
      for (const url of sent) expect(url.searchParams.get('readMask')).toBe('names,emailAddresses');
      expect(sent[1]!.searchParams.get('pageSize')).toBe('5');
    }
  });

  it('merges both sources, saved contacts first, one row per person, at most three addresses and the limit', async () => {
    const { client } = people(
      [person('Priya Nair', 'priya@northwind.example', 'PRIYA@home.example', 'p3@x.example', 'p4@x.example'), person('Priya Shah', 'shah@acme.example')],
      [person(null, 'priya@northwind.example'), person('Priyanka R', 'priyanka@studio.example'), person('No Address')],
    );
    expect(await client.searchContacts!('Priya', 5)).toEqual<readonly ContactMatch[]>([
      { name: 'Priya Nair', emails: ['priya@northwind.example', 'priya@home.example', 'p3@x.example'], source: 'contacts' },
      { name: 'Priya Shah', emails: ['shah@acme.example'], source: 'contacts' },
      { name: 'Priyanka R', emails: ['priyanka@studio.example'], source: 'other_contacts' },
    ]);
    expect(await client.searchContacts!('Priya', 1)).toHaveLength(1);
  });

  it('refuses a bad query or limit before any request', async () => {
    const { client, calls } = people([], []);
    for (const [query, limit] of [['', 5], ['x'.repeat(101), 5], ['Priya', 0], ['Priya', 11]] as const)
      await expect(client.searchContacts!(query, limit)).rejects.toThrow('invalid contacts search');
    expect(calls).toHaveLength(0);
  });

  it('gives the model the matches with what an empty result does and does not mean', async () => {
    const matches: ContactMatch[] = [{ name: 'Meera', emails: ['meera@family.example'], source: 'contacts' }];
    const result = await tool({ account: { connection_id: 'c1', email: 'owner@example.com' }, searchContacts: async () => matches }).handle({ query: 'Meera', limit: 5 } as never);
    expect(result).toMatchObject({ ok: true, source_taint: 'external', data: { query: 'Meera', contacts: matches, coverage: { matching: 'name_or_address_prefix' } } });
  });

  it('offers the connection when no grant holds the contacts scopes, or Google says the scope is missing', async () => {
    expect(await googleHandlers({ client: async () => null }, desk, clock).find((handler) => handler.name === 'search_contacts')!.handle({ query: 'Meera', limit: 5 } as never))
      .toMatchObject({ ok: false, connect: { status: 'auth_required', service: 'google', reason: 'not_connected', feature: 'contacts' } });
    expect(await tool({ searchContacts: async () => { throw new GoogleError(403, 'google 403: insufficient', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'); } }).handle({ query: 'Meera', limit: 5 } as never))
      .toMatchObject({ ok: false, connect: { reason: 'scope_missing', feature: 'contacts' } });
  });

  it('passes on only the contract fields, so nothing else a provider adds can reach the model', async () => {
    const result = await tool({ searchContacts: async () => [
      { name: 'Ana Ruiz', emails: ['ana@studio.example'], source: 'contacts', phone: '+1 555 0100', organization: 'Studio Ltd', photo: 'https://example.test/ana.jpg' },
      { name: 'Broken Row', emails: ['not-an-address'], source: 'contacts' },
    ] }).handle({ query: 'A', limit: 5 } as never);
    expect(result).toMatchObject({ ok: true, data: { contacts: [{ name: 'Ana Ruiz', emails: ['ana@studio.example'], source: 'contacts' }] } });
    expect(JSON.stringify(result)).not.toMatch(/555 0100|Studio Ltd|ana\.jpg|Broken Row/);
  });

  it('reaches the model marked as external text through the real dispatcher', async () => {
    const context = { authenticatedUserId: 'owner', trigger: 'user_message' as const, session: buildSessionState({ trigger: 'user_message', canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1 }), hasApproval: () => false, sourceTaint: null, toolArgSourceTaint: null, sanitise };
    const handler = tool({ searchContacts: async () => [{ name: 'Meera', emails: ['meera@family.example'], source: 'contacts' }] });
    expect(await dispatchTool({ id: 'contacts-read', name: 'search_contacts', args: { query: 'Meera' } }, context, { handlers: [handler] }))
      .toMatchObject({ ok: true, source_taint: 'external', data: { contacts: [{ name: 'Meera' }] } });
    expect(await dispatchTool({ id: 'contacts-forged', name: 'search_contacts', args: { query: 'Meera', phone: true } }, context, { handlers: [handler] }))
      .toMatchObject({ ok: false, code: 'invalid_args' });
  });

  it('tells the model to ask the owner rather than guess between people', () => {
    expect(tool({}).description).toMatch(/ask the owner/i);
  });
});
