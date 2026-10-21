import { expect, it } from 'vitest';
import { isPublicWebUrl } from '../src/channels/public-web-policy';
it('retained requests preserve explicit blocks even with open public access', () => {
 expect(isPublicWebUrl('https://example.com/a', ['*', '-example.com'])).toBe(false);
 expect(isPublicWebUrl('https://sub.example.com/a', ['*', '-example.com'])).toBe(false);
 expect(isPublicWebUrl('https://www.iana.org/b', ['*', '-example.com'])).toBe(true);
 for (const url of ['http://127.0.0.1', 'http://169.254.169.254', 'http://localhost', 'http://[::1]']) expect(isPublicWebUrl(url, ['*'])).toBe(false);
 expect(isPublicWebUrl('https://www.iana.org', ['*', '-bad*host'])).toBe(false);
});

it('finite owner egress applies to redirects and subrequests as well as initial URLs', () => {
 expect(isPublicWebUrl('https://example.com/a', ['example.com'])).toBe(true);
 expect(isPublicWebUrl('https://www.iana.org/b', ['example.com'])).toBe(false);
 expect(isPublicWebUrl('https://www.iana.org/b', ['*', 'example.com'])).toBe(true);
});
