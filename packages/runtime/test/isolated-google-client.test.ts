import { describe, expect, it } from 'vitest';
import { IsolatedSourceWorld } from '../scenarios/isolated-source-world';
import { isolatedGoogleClient } from '../scenarios/isolated-google-client';

const fixture = () => new IsolatedSourceWorld({
  clock: '2026-10-06T09:00:00Z', owners: [{ id: 'a' }, { id: 'b' }],
  sources: {
    mail: [
      { owner_id: 'a', id: 'm1', thread_id: 'shared', from: 'sender@example.invalid', subject: 'Alpha', snippet: 'first', body: 'alpha only', at: '2026-10-06T08:00:00Z' },
      { owner_id: 'b', id: 'm1', thread_id: 'shared', from: 'sender@example.invalid', subject: 'Beta', snippet: 'second', body: 'beta only', at: '2026-10-06T08:00:00Z' },
    ],
    calendar: [
      { owner_id: 'a', id: 'event', title: 'Alpha', start: '2026-10-06T10:00:00Z', end: '2026-10-06T11:00:00Z', all_day: false },
      { owner_id: 'b', id: 'event', title: 'Beta', start: '2026-10-06T10:00:00Z', end: '2026-10-06T11:00:00Z', all_day: false },
    ],
    tasks: [{ owner_id: 'a', id: 'task', title: 'Alpha task', status: 'todo' }],
  },
  revisions: [{ at: '2026-10-06T10:30:00Z', owner_id: 'a', source: 'mail', id: 'm1', patch: { snippet: 'revised' } }],
});

describe('isolated Google source adapter', () => {
  it('keeps same provider IDs scoped to owner and reflects revisions', async () => {
    const world = fixture(); const a = isolatedGoogleClient(world, 'a'); const b = isolatedGoogleClient(world, 'b');
    expect((await a.readThread('shared', 5))[0]?.body).toBe('alpha only');
    expect((await b.readThread('shared', 5))[0]?.body).toBe('beta only');
    expect((await a.events('2026-10-06T09:00:00Z', '2026-10-06T12:00:00Z', 5, false))[0]?.title).toBe('Alpha');
    expect((await b.events('2026-10-06T09:00:00Z', '2026-10-06T12:00:00Z', 5, false))[0]?.title).toBe('Beta');
    expect(await b.tasks('all', 5)).toEqual([]);
    world.advance('2026-10-06T11:00:00Z');
    expect((await a.newMail(Date.parse('2026-10-06T00:00:00Z'), 5))[0]?.snippet).toBe('revised');
    expect((await b.newMail(Date.parse('2026-10-06T00:00:00Z'), 5))[0]?.snippet).toBe('second');
  });
  it('fails closed on effects and unsupported reads', async () => {
    const a = isolatedGoogleClient(fixture(), 'a');
    await expect(a.sendRaw('payload')).rejects.toThrow(/intercepted approval/);
    await expect(a.draft({ to: ['x@example.invalid'], subject: 'x', body: 'x' })).rejects.toThrow(/intercepted approval/);
    await expect(a.searchMail('x', 5)).rejects.toThrow(/not implemented/);
  });
});
