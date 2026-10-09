import { expect, it } from 'vitest';
// @ts-expect-error plain script module without types
import { stagingTarget } from '../scripts/device-bridge-staging-target.mjs';

it('requires an explicit staging URL and a console cookie supplied at run time', () => {
  expect(() => stagingTarget({})).toThrow('WALDO_STAGING_URL');
  expect(() => stagingTarget({ WALDO_STAGING_URL: 'https://waldo-runtime-staging.example.workers.dev' })).toThrow('WALDO_CONSOLE_COOKIE');
});
it('refuses a non-staging or non-https target', () => {
  for (const url of ['http://waldo-runtime-staging.example.workers.dev', 'https://waldo-runtime.example.workers.dev'])
    expect(() => stagingTarget({ WALDO_STAGING_URL: url, WALDO_CONSOLE_COOKIE: 'waldo_owner=x; waldo_console=y' })).toThrow('staging');
});
it('accepts an https staging host and returns its origin and cookie', () => {
  expect(stagingTarget({ WALDO_STAGING_URL: 'https://waldo-runtime-staging.example.workers.dev/', WALDO_CONSOLE_COOKIE: 'waldo_owner=x; waldo_console=y' }))
    .toEqual({ origin: 'https://waldo-runtime-staging.example.workers.dev', cookie: 'waldo_owner=x; waldo_console=y' });
});
