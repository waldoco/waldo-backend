import { googleClient } from '../src/connectors/google';
import { googleHandlers, type GoogleAccess } from '../src/tools/live/google';

const app = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://w.example/oauth/google/callback' };
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-09-23T08:00:00Z') };
const b64 = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// One-message thread t1 with the given subject and body, read through the real read_thread handler.
export const readThread = async (subject: string, body: string, relay?: (from: string, a: readonly { kind: string; value: string }[]) => Promise<boolean>) => {
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at' });
    if (url.includes('/gmail/v1/users/me/threads/t1')) return Response.json({ messages: [
      { id: 'm1', internalDate: '1759143600000', snippet: 's', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'noreply@example.com' }, { name: 'Subject', value: subject }], body: { data: b64(body) } } },
    ] });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const access: GoogleAccess = { client: async () => googleClient(app, { refresh_token: 'rt' }, fetcher) };
  const desk = { propose: async () => 'p', proposeSendEmail: async () => 'p', record: () => {} };
  const read = googleHandlers(access, desk, clock, relay).find((h) => h.name === 'read_thread')!;
  const result = await read.handle({ thread_id: 't1', limit: 10 });
  return (result as { data: { messages: { subject: string; body: string; quarantined?: readonly string[] }[] } }).data.messages[0]!;
};
