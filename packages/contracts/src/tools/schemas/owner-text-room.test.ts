import { describe, expect, it } from 'vitest';
import { logMealArgsSchema, logWorkoutArgsSchema } from './health';
import { setReminderArgsSchema } from './reminders';
import { setStandingOrderArgsSchema } from './standing-orders';

// Text the owner dictates is stored as written and nothing downstream caps it below these sizes, so a detailed reminder,
// standing order or meal log fits in one call instead of being refused.
describe('room for owner-dictated text', () => {
  const words = (chars: number) => 'a'.repeat(chars);

  it('takes a 2,000-character reminder note and standing order, and refuses past that', () => {
    expect(setReminderArgsSchema.safeParse({ note: words(2000), at: '2030-11-04T09:00' }).success).toBe(true);
    expect(setReminderArgsSchema.safeParse({ note: words(2001), at: '2030-11-04T09:00' }).success).toBe(false);
    const order = { scope: words(2000), trigger: 'every_turn', gate: 'act_and_report', escalation: 'message_owner' };
    expect(setStandingOrderArgsSchema.safeParse(order).success).toBe(true);
    expect(setStandingOrderArgsSchema.safeParse({ ...order, scope: words(2001) }).success).toBe(false);
  });

  it('takes a long meal description with up to 100 items, and long workout notes', () => {
    expect(logMealArgsSchema.safeParse({ description: words(2000), items: Array.from({ length: 100 }, () => words(200)) }).success).toBe(true);
    expect(logMealArgsSchema.safeParse({ description: 'lunch', items: Array.from({ length: 101 }, () => 'rice') }).success).toBe(false);
    expect(logWorkoutArgsSchema.safeParse({ type: 'run', notes: words(2000) }).success).toBe(true);
  });
});
