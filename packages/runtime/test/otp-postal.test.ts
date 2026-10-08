import { describe, expect, it } from 'vitest';
import { extractArtifacts } from '../src/security/artifact-hygiene';
import { readThread } from './otp-helpers';

describe('A-8 otp-postal: bare "code" + digits is not an OTP', () => {
  it.each(['Ship to postal code: 560001', 'error code 5001 on checkout', 'Your zip code is 94107'])('%s passes untouched', (text) => {
    expect(extractArtifacts(text)).toEqual({ text, artifacts: [] });
  });
  it('read_thread leaves a postal-code message whole and relays nothing', async () => {
    const relays: unknown[] = [];
    const m = await readThread('Delivery', 'Postal code: 560001, error code 5001.', async (...a) => { relays.push(a); return true; });
    expect(m).toMatchObject({ subject: 'Delivery', body: 'Postal code: 560001, error code 5001.' });
    expect(m.quarantined).toBeUndefined();
    expect(relays).toEqual([]);
  });
});
