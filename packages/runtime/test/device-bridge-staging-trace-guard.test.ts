import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error plain script module without types
import { stagingTarget } from '../scripts/device-bridge-staging-target.mjs';
// @ts-expect-error plain script module without types
import { main } from '../scripts/device-bridge-staging-trace.mjs';
// @ts-expect-error plain script module without types
import { TRACE_PLAN } from '../scripts/device-bridge-staging-plan.mjs';

// Obvious fakes only: no real host, cookie or allowlist ever appears in fixtures.
const host = 'waldo-runtime-staging.example.workers.dev';
const cookie = 'waldo_owner=x; waldo_console=y';
const env = (url: string, extra: Record<string, string> = {}) => ({ WALDO_STAGING_URL: url, WALDO_STAGING_ALLOWED_HOSTS: host, WALDO_CONSOLE_COOKIE: cookie, ...extra });
afterEach(() => { vi.unstubAllGlobals(); });

it('requires an explicit staging URL, an allowlist and a console cookie supplied at run time', () => {
  expect(() => stagingTarget({})).toThrow('WALDO_STAGING_URL');
  expect(() => stagingTarget({ WALDO_STAGING_URL: `https://${host}`, WALDO_CONSOLE_COOKIE: cookie })).toThrow('WALDO_STAGING_ALLOWED_HOSTS');
  expect(() => stagingTarget({ WALDO_STAGING_URL: `https://${host}`, WALDO_STAGING_ALLOWED_HOSTS: ' , ', WALDO_CONSOLE_COOKIE: cookie })).toThrow('WALDO_STAGING_ALLOWED_HOSTS');
  expect(() => stagingTarget({ WALDO_STAGING_URL: `https://${host}`, WALDO_STAGING_ALLOWED_HOSTS: host })).toThrow('WALDO_CONSOLE_COOKIE');
});
it('refuses a non-staging or non-https target', () => {
  for (const url of [`http://${host}`, 'https://waldo-runtime.example.workers.dev'])
    expect(() => stagingTarget(env(url))).toThrow('staging');
});
it('accepts an exactly allowlisted https staging host and returns its origin and cookie', () => {
  expect(stagingTarget(env(`https://${host}/`))).toEqual({ origin: `https://${host}`, cookie });
  // URL normalisation lowercases the host; the comparison is exact after normalisation.
  expect(stagingTarget(env(`https://${host.toUpperCase()}`)).origin).toBe(`https://${host}`);
  expect(stagingTarget(env(`https://${host}`, { WALDO_STAGING_ALLOWED_HOSTS: `other-staging.example.workers.dev, ${host}` })).origin).toBe(`https://${host}`);
  expect(stagingTarget(env(`https://${host}:8443`, { WALDO_STAGING_ALLOWED_HOSTS: `${host}:8443` })).origin).toBe(`https://${host}:8443`);
});
it('refuses lookalike hosts that only contain the word staging', () => {
  for (const url of ['https://staging.attacker.example', 'https://waldo-staging.evil.net', `https://${host}.evil.net`, `https://evil-${host}`, `https://sub.${host}`])
    expect(() => stagingTarget(env(url)), url).toThrow('staging');
});
it('refuses credentials, ports, IP literals, localhost, trailing dots, punycode and non-origin URLs', () => {
  const refused = [
    `https://user:pw@${host}`, `https://user@${host}`,
    `https://${host}:8443`, `https://${host}.`,
    'https://203.0.113.7', 'https://[2001:db8::1]', 'https://localhost', 'https://staging.localhost',
    // Cyrillic "а" lookalike normalises to an xn-- label.
    `https://wаldo-runtime-staging.example.workers.dev`,
    `https://${host}/console`, `https://${host}/?next=x`, `https://${host}/#x`, 'not a url',
  ];
  for (const url of refused) expect(() => stagingTarget(env(url)), url).toThrow(/staging|WALDO_STAGING_URL/);
  for (const url of refused) expect(() => stagingTarget(env(url))).not.toThrow(cookie);
});
it('refuses allowlist entries that are not exact hostnames', () => {
  for (const entry of ['*.example.workers.dev', `https://${host}`, `${host}/`, `${host}.`, '203.0.113.7', 'localhost', `user@${host}`, 'xn--wldo-runtime-staging-5hb.example.workers.dev'])
    expect(() => stagingTarget(env(`https://${host}`, { WALDO_STAGING_ALLOWED_HOSTS: entry })), entry).toThrow('WALDO_STAGING_ALLOWED_HOSTS');
});
it('refuses a multi-line cookie that could inject headers', () => {
  expect(() => stagingTarget(env(`https://${host}`, { WALDO_CONSOLE_COOKIE: `${cookie}\r\nx-injected: 1` }))).toThrow('WALDO_CONSOLE_COOKIE');
});
it('dry run prints the guarded origin and the ordered effects without any network call or cookie output', async () => {
  const fetch = vi.fn(), WebSocket = vi.fn(), loadFlow = vi.fn();
  vi.stubGlobal('fetch', fetch); vi.stubGlobal('WebSocket', WebSocket);
  for (const [argv, extra] of [[['--dry-run'], {}], [[], { WALDO_TRACE_DRY_RUN: '1' }]] as const) {
    const lines: string[] = [];
    const code = await main({ env: env(`https://${host}`, extra), argv, log: (line: string) => lines.push(line), fail: (line: string) => lines.push(line), loadFlow });
    expect(code).toBe(0);
    expect(lines[0]).toBe(`STAGING DRY-RUN: target origin https://${host}`);
    expect(lines.slice(1, -1)).toEqual(TRACE_PLAN.map((step: { effect: string }, i: number) => `STAGING DRY-RUN: ${i + 1}. ${step.effect}`));
    expect(lines.at(-1)).toBe('STAGING DRY-RUN: no request was sent');
    expect(lines.join('\n')).not.toContain('waldo_console=y');
  }
  expect(fetch).not.toHaveBeenCalled(); expect(WebSocket).not.toHaveBeenCalled(); expect(loadFlow).not.toHaveBeenCalled();
});
it('refuses before any network call when the guard or arguments reject the run', async () => {
  const fetch = vi.fn(), loadFlow = vi.fn(), lines: string[] = [];
  vi.stubGlobal('fetch', fetch);
  const log = (line: string) => lines.push(line);
  expect(await main({ env: env('https://staging.attacker.example'), argv: [], log, fail: log, loadFlow })).toBe(1);
  expect(await main({ env: env(`https://${host}`), argv: ['--dryrun'], log, fail: log, loadFlow })).toBe(1);
  expect(fetch).not.toHaveBeenCalled(); expect(loadFlow).not.toHaveBeenCalled();
  expect(lines.every(line => line.startsWith('STAGING: REFUSED '))).toBe(true);
  expect(lines.join('\n')).not.toContain('waldo_console=y');
});
it('plans the trace effects with stable unique keys', () => {
  const keys = TRACE_PLAN.map((step: { key: string }) => step.key);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys).toEqual(['healthz', 'unsigned_redeem', 'console_devices', 'pair', 'redeem', 'connect', 'heartbeat_online', 'query', 'revoke', 'revoked_reconnect']);
});
