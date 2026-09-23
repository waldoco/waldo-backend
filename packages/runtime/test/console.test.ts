import { describe, expect, it } from 'vitest';
import { consoleAccess, renderConsole, sessionCookie } from '../src/channels/console';

const memoryStore = () => {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (key: string) => data.delete(key),
  };
};

describe('owner console', () => {
  it('redeems a link once, before it expires, into a session', async () => {
    let now = 1_000;
    const access = consoleAccess(memoryStore(), () => now);
    const link = new URL(await access.mintLink('https://waldo.example'));
    const token = link.searchParams.get('t')!;
    expect(link.pathname).toBe('/console');
    expect(await access.redeem('wrong')).toBeNull();
    const session = await access.redeem(token);
    expect(session).toMatch(/^[0-9a-f]{64}$/);
    expect(await access.redeem(token)).toBeNull();
    expect(await access.valid(session)).toBe(true);
    expect(await access.valid(null)).toBe(false);
    now += 13 * 60 * 60_000;
    expect(await access.valid(session)).toBe(false);
    const late = new URL(await access.mintLink('https://waldo.example')).searchParams.get('t')!;
    now += 11 * 60_000;
    expect(await access.redeem(late)).toBeNull();
  });

  it('reads the session cookie', () => {
    expect(sessionCookie(new Request('https://x/console', { headers: { cookie: 'a=1; waldo_console=abc' } }))).toBe('abc');
    expect(sessionCookie(new Request('https://x/console'))).toBeNull();
  });

  it('renders every section and escapes stored text', () => {
    const html = renderConsole({
      release: 'abc1234', timezone: 'Asia/Kolkata', google: { connected: true, email: 'owner@example.com' },
      memory: { MEMORY_CORE: 'Gym <11am>', MEMORY_GOALS: '', MEMORY_FOLLOWUPS: '', 'intelligence-summary': '' },
      spots: [{ id: 1, kind: 'pattern', text: '<script>x</script>', source: 'stated', evidence: 'owner', status: 'active', created_at: '2026-09-23T00:00:00Z', last_seen_at: '2026-09-23T00:00:00Z', seen_count: 2 }],
      retiredSpots: [], nodes: [{ id: 1, domain: 'sleep', label: 'Short sleep', summary: 'Under 6h', strength: 0.6, status: 'active', first_seen: '2026-09-23', last_confirmed: '2026-09-23', supporting_spots: '[]' }],
      edges: [], cards: [{ card: 'card:brief', time: '08:30', reason: 'gym at 11', sent: false }],
      ledger: 'Open: none', checklist: '[ ] Chat reply: not seen', trace: '10:00 ok llm_reply',
    });
    for (const title of ['Connectors', 'Spots', 'Constellation', "Today&#39;s cards", 'Memory', 'Ledger and reminders', 'E2E checklist', 'Recent trace']) expect(html).toContain(title);
    expect(html).toContain('connected as owner@example.com');
    expect(html).toContain('&#60;script&#62;x&#60;/script&#62;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Gym &#60;11am&#62;');
  });
});
