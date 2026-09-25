import { describe, expect, it } from 'vitest';
import { telegramLinked } from '../src/channels/console';

// The identity kv as the DO sees it: telegram_subject is put when presence routing delivers
// a message; telegram_unlinked is put by the console unlink action and deleted on rebind.
const kv = (entries: Record<string, unknown> = {}) => ({ get: <T>(key: string): T | undefined => entries[key] as T | undefined });

describe('console telegram linked state', () => {
  it('a fresh owner who never linked reads NOT connected (the staging live bug)', () => {
    expect(telegramLinked(kv())).toBe(false);
  });

  it('an owner linked by an active presence reads connected', () => {
    expect(telegramLinked(kv({ telegram_subject: '42' }))).toBe(true);
  });

  it('a console-unlinked owner reads NOT connected even though the subject key remains', () => {
    expect(telegramLinked(kv({ telegram_subject: '42', telegram_unlinked: true }))).toBe(false);
  });

  it('the unlink flag alone never implies a link', () => {
    expect(telegramLinked(kv({ telegram_unlinked: true }))).toBe(false);
  });
});
