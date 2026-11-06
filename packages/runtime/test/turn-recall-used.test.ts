import { describe, expect, it } from 'vitest';
import { recallForTurn } from '../src/memory/turn-recall';
import type { Claim } from '../src/memory/claims';

const claim = (id: number, text: string): Claim => ({ id, kind: 'fact', text, source: 'stated', evidence: 'e', origin: 'owner', status: 'active', created_at: '2026-10-01', last_seen_at: '2026-10-01', seen_count: 1, verification_status: 'owner-grounded' });
const never = () => false;

describe('what recall shows in full', () => {
  it('names the claims it showed as full lines, and the header tells the model to say which it relied on if asked', async () => {
    const claims = { recall: () => [claim(3, 'Lives in Leeds near the canal'), claim(9, 'Canal walks on Sundays')] };
    const recalled = await recallForTurn({ claims, question: 'the canal near Leeds', room: 4000, holds: never });
    expect(recalled.used).toEqual([3, 9]);
  });

  it('leaves out a stub, a claim a hold withheld, and a recall that found nothing', async () => {
    const many = Array.from({ length: 14 }, (_, index) => claim(index + 1, `Canal fact number ${index + 1}`));
    const full = await recallForTurn({ claims: { recall: () => many }, question: 'canal facts', room: 4000, holds: never, stubs: true });
    expect(full.used).toHaveLength(12);
    expect(full.used).not.toContain(13);
    const held = await recallForTurn({ claims: { recall: () => [claim(1, 'Secret canal plan'), claim(2, 'Open canal plan')] }, question: 'canal plan', room: 4000, holds: (...values) => values.some(value => typeof value === 'string' && value.includes('Secret')) });
    expect(held.used).toEqual([2]);
    expect((await recallForTurn({ claims: { recall: () => [] }, question: 'canal', room: 4000, holds: never })).used ?? []).toEqual([]);
  });
});
