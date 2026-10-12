import { describe, expect, it } from 'vitest';
import { resolveOwnerTelegramId } from '../src/channels/telegram-owner-do';

// Regression for the multi-user identity bug: a directory-backed DO whose owner had not linked
// Telegram yet fell back to WALDO_OWNER_TELEGRAM_ID, so a second owner signing in through the
// console would have run a runtime wearing the FIRST owner's Telegram identity - turns attributed
// to him, and messages (e.g. the Google-connected confirmation) sent to his chat.
describe('resolveOwnerTelegramId', () => {
  it('a directory-backed owner without a linked Telegram subject gets 0, never the deploy owner id', () => {
    expect(resolveOwnerTelegramId(undefined, { WALDO_OWNER_TELEGRAM_ID: '42' }, true)).toBe(0);
  });

  it('a linked subject always wins, directory-backed or not', () => {
    expect(resolveOwnerTelegramId('777', { WALDO_OWNER_TELEGRAM_ID: '42' }, true)).toBe(777);
    expect(resolveOwnerTelegramId('777', { WALDO_OWNER_TELEGRAM_ID: '42' }, false)).toBe(777);
  });

  it('the legacy single-owner deploy keeps its env fallback', () => {
    expect(resolveOwnerTelegramId(undefined, { WALDO_OWNER_TELEGRAM_ID: '42' }, false)).toBe(42);
  });

  it('no subject and no fallback means unconfigured (0), not an exception with a borrowed identity', () => {
    expect(resolveOwnerTelegramId(undefined, {}, false)).toBe(0);
    expect(resolveOwnerTelegramId(undefined, {}, true)).toBe(0);
  });
});
