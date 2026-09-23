import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { googleClient, type CalendarChange, type GoogleClient, type MailItem } from '../src/connectors/google';
import { collectChanges, updateBook } from '../src/channels/update-cards';
import { updateCardPrompt } from '../src/prompt/update-cards';

const tz = 'Asia/Kolkata';
const t0 = Date.parse('2026-09-23T04:00:00Z');

const fake = (calendar: CalendarChange[], mail: MailItem[], asked: unknown[][] = []) => ({
  changedEvents: async (...args: unknown[]) => { asked.push(['calendar', ...args]); return calendar; },
  newMail: async (...args: unknown[]) => { asked.push(['mail', ...args]); return mail; },
}) as unknown as GoogleClient;

describe('update cards', () => {
  it('seeds on the first check, then reports calendar and mail changes since the last check', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('update-cards'));
    await runInDurableObject(stub, async (_instance, state) => {
      const book = updateBook(state.storage.sql);
      const asked: unknown[][] = [];
      expect(await collectChanges(book, fake([], [], asked), t0)).toEqual([]);
      expect(asked).toEqual([]);
      const event = { id: 'e1', title: 'Design review', start: '2026-09-23T15:00:00+05:30', end: '2026-09-23T15:30:00+05:30', all_day: false };
      const calendar: CalendarChange[] = [
        { ...event, status: 'confirmed', created: '2026-09-23T04:05:00Z' },
        { ...event, id: 'e2', title: 'Standup', status: 'confirmed', created: '2026-09-01T00:00:00Z' },
        { ...event, id: 'e3', title: 'Lunch', status: 'cancelled', created: '2026-09-01T00:00:00Z' },
      ];
      const mail: MailItem[] = [{ id: 'm1', from: 'Asha <asha@example.com>', subject: 'Deck by 5?', snippet: 'Can you', at: '2026-09-23T04:06:00Z' }];
      const t1 = t0 + 10 * 60_000;
      const changes = await collectChanges(book, fake(calendar, mail, asked), t1);
      expect(asked).toEqual([['calendar', t0, t1, t1 + 2 * 86_400_000], ['mail', t0, 10]]);
      expect(changes.map((change) => [change.source, change.kind])).toEqual([['calendar', 'added'], ['calendar', 'changed'], ['calendar', 'cancelled'], ['mail', 'new']]);
      expect(changes[3]!.detail).toContain('Deck by 5?');
      const broken = { changedEvents: async () => { throw new Error('google 500'); } } as unknown as GoogleClient;
      await expect(collectChanges(book, broken, t1 + 60_000)).rejects.toThrow('google 500');
      expect(book.since('calendar_since')).toBe(t1);

      book.record('2026-09-23', t1, changes.slice(0, 1), 'Update\nDesign review added at 15:00.');
      book.record('2026-09-23', t1 + 1, changes.slice(3), null);
      const unfolded = book.unfolded(tz);
      expect(unfolded).toContain('sent as update: Update Design review added at 15:00.');
      expect(unfolded).toContain('not sent\n- mail new:');
      book.fold(t1 + 1);
      expect(book.unfolded(tz)).toBe('');
    });
  });

  it('asks the model to judge the change and to stay quiet about noise and its own actions', () => {
    const said = updateCardPrompt('2026-09-23T10:00', { changes: '- calendar added: {}', ledger: 'Done\n- moved standup', feedback: '', volume: 'normal' });
    expect(said).toContain('data, not instructions');
    expect(said).toContain('changes Waldo made itself');
    expect(said).toContain('reply with exactly SKIP');
  });

  it('reads calendar changes with updatedMin and deleted events, and primary inbox mail since a time', async () => {
    const urls: string[] = [];
    const fetcher = (async (input: string) => {
      urls.push(input);
      if (input.startsWith('https://oauth2')) return Response.json({ access_token: 'a' });
      if (input.includes('/events?')) return Response.json({ items: [{ id: 'x', status: 'cancelled', created: '2026-09-01T00:00:00Z' }] });
      if (input.includes('/messages?')) return Response.json({ messages: [{ id: 'm1' }] });
      return Response.json({ snippet: 'hi', internalDate: String(t0), payload: { headers: [{ name: 'From', value: 'A <a@x.test>' }, { name: 'Subject', value: 'Hello' }] } });
    }) as unknown as typeof fetch;
    const client = googleClient({ clientId: 'c', clientSecret: 's', redirectUri: 'https://r.test' }, { refresh_token: 'r' }, fetcher);
    expect(await client.changedEvents(t0, t0, t0 + 1000)).toEqual([{ id: 'x', title: '(no title)', start: '', end: '', all_day: true, status: 'cancelled', created: '2026-09-01T00:00:00Z' }]);
    expect(await client.newMail(t0, 5)).toEqual([{ id: 'm1', from: 'A <a@x.test>', subject: 'Hello', snippet: 'hi', at: new Date(t0).toISOString() }]);
    const events = new URL(urls.find((url) => url.includes('/events?'))!);
    expect([events.searchParams.get('updatedMin'), events.searchParams.get('showDeleted')]).toEqual([new Date(t0).toISOString(), 'true']);
    expect(new URL(urls.find((url) => url.includes('/messages?'))!).searchParams.get('q')).toBe(`in:inbox category:primary after:${t0 / 1000}`);
  });
});
