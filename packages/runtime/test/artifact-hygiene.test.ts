import { describe, expect, it } from 'vitest';
import { artifactMarker, onlyArtifacts, quarantineArtifacts } from '../src/security/artifact-hygiene';

const ARTIFACTS: ReadonlyArray<{ text: string; kinds: string[]; stolen: string }> = [
  // gmail-class OTPs
  { text: 'Your Google verification code is 123456', kinds: ['otp'], stolen: '123456' },
  { text: 'G-729314 is your Google verification code.', kinds: ['otp'], stolen: '729314' },
  { text: '123456 is your Google verification code', kinds: ['otp'], stolen: '123456' },
  { text: 'Your WhatsApp code: 123-456', kinds: ['otp'], stolen: '123-456' },
  { text: '123-456 is your WhatsApp code. You can also tap this link: wa.me/verify', kinds: ['otp'], stolen: '123-456' },
  { text: 'Your login code is 847291. It expires in 10 minutes.', kinds: ['otp'], stolen: '847291' },
  { text: 'Security code: 003311. Do not share this with anyone.', kinds: ['otp'], stolen: '003311' },
  { text: 'Use OTP 554433 to sign in', kinds: ['otp'], stolen: '554433' },
  // magic links
  { text: 'Confirm: https://togdshayyxycitzckpqv.supabase.co/auth/v1/verify?token=pkce_ABCSECRET&type=magiclink&redirect_to=https://waldo.dev', kinds: ['magic_link'], stolen: 'pkce_ABCSECRET' },
  { text: 'Reset here https://app.example.com/auth/confirm?token_hash=def456ghi&type=recovery now', kinds: ['password_reset'], stolen: 'token_hash=def456ghi' },
  { text: 'Reset: https://togdshayyxycitzckpqv.supabase.co/auth/v1/verify?token=pkce_REC&type=recovery&redirect_to=https://waldo.dev', kinds: ['password_reset'], stolen: 'pkce_REC' },
  { text: 'https://accounts.example.com/reset-password?token=zzz999&user=me', kinds: ['password_reset'], stolen: 'token=zzz999' },
  { text: 'click https://x.example.com/confirm?confirmation_token=q1w2e3 to finish', kinds: ['password_reset'], stolen: 'confirmation_token=q1w2e3' },
  // mixed: an OTP and a magic link in one pasted forward
  { text: 'Fwd: Your sign-in code is 445566 or open https://a.b/auth/v1/verify?token=t0k3n&type=magiclink', kinds: ['otp', 'magic_link'], stolen: '445566' },
];

const CLEAN: readonly string[] = [
  'Your receipt from Amazon: $12.34 for order #112-3948572-1849561',
  'Order 482910 has shipped and arrives Thursday',
  'Your appointment is at 1600 on 2026-09-26',
  'Meeting moved to 14:30, room 4821',
  'Your statement for account ending 1234 is ready',
  'Lunch at 123456 Elm Street?',
  'see you at 6, the gate code is not needed anymore',
  'a:p12',
];

describe('artifact hygiene quarantine', () => {
  for (const { text, kinds, stolen } of ARTIFACTS) {
    it(`quarantines ${kinds.join('+')}: ${text.slice(0, 40)}...`, () => {
      const q = quarantineArtifacts(text);
      expect(q.kinds).toEqual([...kinds].sort());
      expect(q.text).not.toContain(stolen);
      for (const kind of kinds) expect(q.text).toContain(artifactMarker(kind as never));
    });
  }

  it('ordinary mail, receipts, addresses and chat flow through untouched (same string identity)', () => {
    for (const text of CLEAN) {
      const q = quarantineArtifacts(text);
      expect(q.kinds).toEqual([]);
      expect(q.text).toBe(text);
    }
  });

  it('falsifier: no artifact substring survives anywhere in the redacted output, markers included', () => {
    for (const { text, stolen } of ARTIFACTS) {
      const q = quarantineArtifacts(text);
      expect(JSON.stringify(q)).not.toContain(stolen);
    }
  });

  it('a standalone 4-8 digit number with no verification keyword is NOT quarantined (fail-closed only on artifact shape)', () => {
    expect(quarantineArtifacts('pin 4821 on the whiteboard').kinds).toEqual([]);
    expect(quarantineArtifacts('call me at 553421').kinds).toEqual([]);
  });

  it('onlyArtifacts: a message that is nothing but the artifact reads as fully quarantined', () => {
    expect(onlyArtifacts(quarantineArtifacts('G-729314'))).toBe(true);
    expect(onlyArtifacts(quarantineArtifacts('code: 123456'))).toBe(true);
    expect(onlyArtifacts(quarantineArtifacts('hello world'))).toBe(false);
    expect(onlyArtifacts(quarantineArtifacts('my code is 123456, also lunch?'))).toBe(false);
  });

  it('multi-line forwarded mail with the code on the second line is still caught', () => {
    const q = quarantineArtifacts('Fwd from bank\nYour one-time passcode is 918273\nregards');
    expect(q.kinds).toEqual(['otp']);
    expect(q.text).not.toContain('918273');
    expect(q.text).toContain('Fwd from bank');
  });
});
