import { describe, expect, it } from 'vitest';
import { renderMemberInvites } from '../src/channels/console-invites';
import { newInviteCode, inviteLink } from '../src/identity/invite-code';

describe('member invites', () => {
  it('shows remaining slots, escapes source data and never shows stored hashes', () => {
    const html = renderMemberInvites([{ email: '<b>@test.invalid', created_at: '2026-09-28T01:00:00Z', expires_at: '2026-10-12T01:00:00Z', used_at: null, revoked_at: null }], 'csrf');
    expect(html).toContain('1/5 issued');
    expect(html).toContain('value="invite.member"');
    expect(html).not.toContain('<b>@test.invalid');
    expect(html).toContain('&#60;b&#62;@test.invalid');
  });
  it('caps visible issuance and generates high-entropy alphabet-only codes', () => {
    const invites = Array.from({ length: 5 }, (_, i) => ({ email: `p${i}@test.invalid`, created_at: '2026-09-28T01:00:00Z', expires_at: null, used_at: null, revoked_at: null }));
    const html = renderMemberInvites(invites, 'csrf');
    expect(html).toContain('5/5 issued');
    expect(html).not.toContain('value="invite.member"');
    const codes = Array.from({ length: 100 }, newInviteCode);
    expect(new Set(codes).size).toBe(100);
    expect(codes.every((code) => /^[A-HJ-NP-Z2-9]{20}$/.test(code))).toBe(true);
  });
});

describe('invite links', () => {
  it('keeps recipient and bearer code out of the HTTP URL', () => {
    const link = new URL(inviteLink('https://w.test/console/action?ignored=1', 'Person+tag@example.com', 'ABCDEFGHJKLMNPQRSTUV'));
    expect(link.pathname).toBe('/console/signup');
    expect(link.search).toBe('');
    expect(new URLSearchParams(link.hash.slice(1)).get('invite')).toBe('ABCDEFGHJKLMNPQRSTUV');
    expect(new URLSearchParams(link.hash.slice(1)).get('email')).toBe('person+tag@example.com');
  });
});
