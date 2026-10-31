import { describe, expect, it } from 'vitest';
import { LIFE_AREAS, lifeAreaSchema, readMemoryArgsSchema, readMemoryClaimSchema, rememberArgsSchema } from '../index';

describe('life areas', () => {
  it('are the seven parts of a life plus unsorted', () => {
    expect(LIFE_AREAS).toEqual(['body', 'mind', 'home', 'work', 'people', 'goals', 'money', 'unsorted']);
    for (const area of LIFE_AREAS) expect(lifeAreaSchema.safeParse(area).success).toBe(true);
  });

  it('refuses anything else, including the older three and other spellings', () => {
    for (const area of ['health', 'personal', 'Work', ' work', '', null, 3]) expect(lifeAreaSchema.safeParse(area).success).toBe(false);
  });

  it('remember and read_memory take an area, and a read names each claim\'s area', () => {
    const remember = { kind: 'routine', text: 'Runs on Sundays', evidence_quote: 'I run on Sundays' };
    expect(rememberArgsSchema.safeParse({ ...remember, area: 'body' }).success).toBe(true);
    expect(rememberArgsSchema.safeParse(remember).success).toBe(true);
    expect(rememberArgsSchema.safeParse({ ...remember, area: 'health' }).success).toBe(false);
    expect(readMemoryArgsSchema.safeParse({ area: 'money' }).success).toBe(true);
    expect(readMemoryArgsSchema.safeParse({ area: 'finance' }).success).toBe(false);
    const claim = { id: 1, kind: 'fact', text: 'Rent is due on the first', evidence: 'x', source: 'stated', origin: 'owner', source_ref: null, verification_status: 'owner-grounded', supersedes_id: null, last_seen_at: '2026-10-30' };
    expect(readMemoryClaimSchema.safeParse({ ...claim, area: 'money' }).success).toBe(true);
    expect(readMemoryClaimSchema.safeParse(claim).success).toBe(true);
    expect(readMemoryClaimSchema.safeParse({ ...claim, area: 'bills' }).success).toBe(false);
  });
});
