import { expect, it } from 'vitest';
import { publicBrowserRequestAuthorizer } from '../src/channels/public-browser-request-filter';

const PUBLIC_WEB = '*';
const privateTargets = ['https://127.0.0.1/', 'https://localhost/', 'https://169.254.169.254/latest/meta-data/', 'https://10.0.0.1/', 'https://[::1]/', 'https://metadata.google.internal/', 'https://user:pass@example.com/'];

it('lets a public-web grant read public pages with GET and HEAD only', async () => {
  const authorize = publicBrowserRequestAuthorizer([PUBLIC_WEB]);
  expect(await authorize('https://example.com/', 'GET')).toBe(true);
  expect(await authorize('https://example.com/', 'HEAD')).toBe(true);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) expect(await authorize('https://example.com/', method)).toBe(false);
});

it('refuses private, loopback, metadata, internal and credentialed targets under a public-web grant', async () => {
  const authorize = publicBrowserRequestAuthorizer([PUBLIC_WEB]);
  for (const url of privateTargets) expect(await authorize(url, 'GET'), url).toBe(false);
  expect(await authorize('not a url', 'GET')).toBe(false);
});

it('confines an origin grant to its origin', async () => {
  const authorize = publicBrowserRequestAuthorizer(['https://docs.example']);
  expect(await authorize('https://docs.example/a', 'GET')).toBe(true);
  expect(await authorize('https://other.example/a', 'GET')).toBe(false);
});
