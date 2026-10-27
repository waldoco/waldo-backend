import { describe, expect, it } from 'vitest';
import { publicOrigin } from '../src/connectors/public-origin';

describe('publicOrigin', () => {
  it('is the request origin when the environment names none', () => {
    expect(publicOrigin({}, 'https://w.test/telegram/webhook?x=1')).toBe('https://w.test');
    expect(publicOrigin({ WALDO_PUBLIC_ORIGIN: '' }, new URL('https://w.test/app/v1/chat'))).toBe('https://w.test');
  });

  it('is the configured origin whichever host the request reached', () => {
    const env = { WALDO_PUBLIC_ORIGIN: 'https://staging.fixture.invalid' };
    expect(publicOrigin(env, 'https://old-host.fixture.invalid/telegram/webhook')).toBe('https://staging.fixture.invalid');
    expect(publicOrigin(env, 'https://staging.fixture.invalid/app/v1/chat')).toBe('https://staging.fixture.invalid');
  });

  it('keeps an explicit port', () => {
    expect(publicOrigin({ WALDO_PUBLIC_ORIGIN: 'https://staging.fixture.invalid:8443' }, 'https://w.test/')).toBe('https://staging.fixture.invalid:8443');
  });

  it.each([
    'http://staging.fixture.invalid',
    'https://staging.fixture.invalid/',
    'https://staging.fixture.invalid/console',
    'https://staging.fixture.invalid?x=1',
    'https://staging.fixture.invalid#x',
    'https://user:pass@staging.fixture.invalid',
    'https://STAGING.fixture.invalid',
    ' https://staging.fixture.invalid',
    'staging.fixture.invalid',
    'not a url',
  ])('refuses a configured value that is not a bare https origin: %s', (value) => {
    expect(() => publicOrigin({ WALDO_PUBLIC_ORIGIN: value }, 'https://w.test/')).toThrow('WALDO_PUBLIC_ORIGIN');
  });
});
