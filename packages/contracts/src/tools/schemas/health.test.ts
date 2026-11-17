import { describe, expect, it } from 'vitest';
import { deleteHealthLogArgsSchema, setSleepNeedArgsSchema, setSleepNeedResultSchema } from './health';

// Every value here is synthetic.
describe('set_sleep_need', () => {
  it('takes the owner\'s stated need in whole minutes within the engine\'s range, or null to clear it', () => {
    for (const args of [{ minutes: 480 }, { minutes: 360 }, { minutes: 600 }, { minutes: null }]) {
      expect(setSleepNeedArgsSchema.safeParse(args).success, JSON.stringify(args)).toBe(true);
    }
    for (const args of [{}, { minutes: 359 }, { minutes: 601 }, { minutes: 450.5 }, { minutes: '480' }, { minutes: 480, owner: 'x' }, { hours: 8 }]) {
      expect(setSleepNeedArgsSchema.safeParse(args).success, JSON.stringify(args)).toBe(false);
    }
  });

  it('answers in words only, so the turn that set it carries no figure back into its own output', () => {
    expect(setSleepNeedResultSchema.safeParse({ state: 'set' }).success).toBe(true);
    expect(setSleepNeedResultSchema.safeParse({ state: 'cleared' }).success).toBe(true);
    for (const result of [{ state: 'set', minutes: 480 }, { state: 'saved' }, {}]) expect(setSleepNeedResultSchema.safeParse(result).success, JSON.stringify(result)).toBe(false);
  });
});

describe('delete_health_log', () => {
  it('takes one positive integer id and nothing else', () => {
    expect(deleteHealthLogArgsSchema.safeParse({ id: 7 }).success).toBe(true);
    for (const args of [{}, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: '7' }, { id: 7, kind: 'meal' }, { ids: [7] }]) {
      expect(deleteHealthLogArgsSchema.safeParse(args).success, JSON.stringify(args)).toBe(false);
    }
  });
});
