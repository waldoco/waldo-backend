import { describe, expect, it } from 'vitest';
import { sendConsoleLinkArgsSchema, sendConsoleLinkResultSchema } from './console-link';

// ADR-0029 valid + invalid pair per schema. The link is a credential: the arguments can never name a destination and
// the result can never carry a URL, ticket or message text back to the model.
describe('send_console_link arguments', () => {
  it('accepts the empty object', () => {
    expect(sendConsoleLinkArgsSchema.safeParse({}).success).toBe(true);
  });

  it('rejects any field, so the model cannot choose a surface, chat or address', () => {
    for (const smuggled of [{ surface: 'telegram' }, { chat_id: 7 }, { to: 'owner@example.invalid' }, { url: 'https://waldo.invalid/console' }]) {
      expect(sendConsoleLinkArgsSchema.safeParse(smuggled).success, JSON.stringify(smuggled)).toBe(false);
    }
    expect(sendConsoleLinkArgsSchema.safeParse(null).success).toBe(false);
  });
});

describe('send_console_link result', () => {
  it('accepts a send on a surface that can carry the link, and every typed reason it was not sent', () => {
    for (const surface of ['telegram', 'imessage']) expect(sendConsoleLinkResultSchema.safeParse({ sent: true, surface }).success, surface).toBe(true);
    for (const reason of ['app_unsupported', 'surface_unsupported', 'not_owner_typed', 'outside_content', 'already_sent', 'unavailable', 'send_failed']) {
      expect(sendConsoleLinkResultSchema.safeParse({ sent: false, reason }).success, reason).toBe(true);
    }
  });

  it('rejects a link, a free-text reason, a mixed arm and a surface that cannot carry the link', () => {
    const rejected = [
      { sent: true, surface: 'telegram', link: 'https://waldo.invalid/console?t=c1.payload.signature' },
      { sent: true, surface: 'app' },
      { sent: true, surface: 'whatsapp' },
      { sent: true },
      { sent: false, reason: 'the owner seemed unsure' },
      { sent: false, reason: 'unavailable', surface: 'telegram' },
      { sent: false },
      { sent: 'yes', surface: 'telegram' },
    ];
    for (const value of rejected) expect(sendConsoleLinkResultSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});
