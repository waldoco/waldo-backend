import { describe, expect, it } from 'vitest';
import { artifactMarker, extractArtifacts } from '../src/security/artifact-hygiene';
import { readThread } from './otp-helpers';

describe('A-8 otp-real: real OTPs still caught, redacted inline', () => {
  it.each([
    ['Your verification code is 123456', '123456'],
    ['Use OTP 554433 to sign in', '554433'],
    ['passcode: 778899', '778899'],
    ['G-729314 is your Google verification code', '729314'],
  ])('%s', (text, code) => {
    const e = extractArtifacts(text);
    expect(e.artifacts.map((a) => a.kind)).toEqual(['otp']);
    expect(e.text).not.toContain(code);
  });
  it('read_thread replaces only the matched span and keeps the rest (relay ok)', async () => {
    const relays: unknown[] = [];
    const m = await readThread('Sign in: Acme login code is 847291', 'Hi Sam,\nYour login code is 847291. It expires in 10 minutes.', async (from, a) => { relays.push({ from, a }); return true; });
    expect(m.body).toBe('Hi Sam,\n[otp artifact - sent to the owner in a separate message]. It expires in 10 minutes.');
    expect(m.subject).toBe('Sign in: [otp artifact - sent to the owner in a separate message]');
    expect(m.quarantined).toEqual(['otp']);
    expect(relays).toEqual([{ from: 'noreply@example.com', a: [{ kind: 'otp', value: '847291' }] }]);
    expect(JSON.stringify(m)).not.toContain('847291');
  });
  it('failed relay keeps the source-app marker inline, no false sent claim', async () => {
    const m = await readThread('Sign in', 'Hello. Your login code is 847291. Bye.', async () => { throw new Error('down'); });
    expect(m.body).toBe(`Hello. ${artifactMarker('otp')}. Bye.`);
    expect(JSON.stringify(m)).not.toContain('847291');
  });
});
