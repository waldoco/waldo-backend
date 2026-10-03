import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountRemoval, fetchOwnerControls, MemberInvites, memberInviteStatus, OwnerChangeError, OwnerReceipt, readOwnerControls, readOwnerResult, submitOwnerControl, type OwnerRead } from './OwnerControls';
const revision = 'a'.repeat(64);
const row = { email: '<script>recipient</script>', created_at: '2026-10-01T00:00:00Z', expires_at: '2026-10-15T00:00:00Z', used_at: null as string | null, revoked_at: null as string | null };
const wire = (view: 'invites' | 'account' = 'invites') => ({ version: 1, state: 'available', view, csrf: 'session-csrf', revision, data: view === 'invites' ? { issued: 1, limit: 5, creation_available: true, expiry_days: 14, invites: [row] } : { deletion_available: true } });
const creation = () => ({ duplicate: false, receipt: { state: 'recorded', message: 'Invite recorded. No email sent.' }, invite: { email: 'recipient@example.com', code: 'ABCDEFGHJKLMNPQRSTU2', link: 'https://console.example/console/signup#email=recipient%40example.com&invite=ABCDEFGHJKLMNPQRSTU2', expiry_days: 14 } });
afterEach(() => vi.unstubAllGlobals());
describe('modern member invites', () => {
  it('shows source-backed total quota, delivery honesty, signup limits and escaped history', () => {
    const record = readOwnerControls(wire(), 'invites') as Extract<OwnerRead, { view: 'invites' }>;
    const html = renderToStaticMarkup(<MemberInvites record={record} busy={false} blocked={false} onSubmit={() => {}}/>);
    expect(html).toContain('1 of 5 total invites issued');
    expect(html).toContain('Used, expired and revoked invites still count');
    expect(html).toContain('does not share your owner data');
    expect(html).toContain('Signup follows Waldo’s available verification flow');
    expect(html).not.toContain('SMS verification is not configured');
    expect(html).toContain('does not email or resend');
    expect(html).toContain('&lt;script&gt;recipient&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('>Resend');
    expect(html).not.toContain('>Revoke');
  });
  it('disables creation at exhausted quota or while an earlier creation is unresolved', () => {
    const record = readOwnerControls(wire(), 'invites') as Extract<OwnerRead, { view: 'invites' }>;
    const blocked = renderToStaticMarkup(<MemberInvites record={record} busy={false} blocked onSubmit={() => {}}/>);
    expect(blocked).toContain('disabled=""'); expect(blocked).toContain('do not recreate the same invite blindly');
    const exhausted = { ...record, data: { ...record.data, issued: 5, creation_available: false } };
    const html = renderToStaticMarkup(<MemberInvites record={exhausted} busy={false} blocked={false} onSubmit={() => {}}/>);
    expect(html).toContain('You have used all five invites'); expect(html).not.toContain('<form');
  });
  it('preserves used/revoked/expired/pending distinctions without claiming delivery', () => {
    expect(memberInviteStatus({ ...row, used_at: row.created_at, revoked_at: row.created_at }, 0)).toBe('Used');
    expect(memberInviteStatus({ ...row, revoked_at: row.created_at }, 0)).toBe('Revoked');
    expect(memberInviteStatus(row, Date.parse('2026-10-16'))).toBe('Expired');
    expect(memberInviteStatus(row, Date.parse('2026-10-02'))).toBe('Pending');
  });
  it('drops secret fields and refuses inconsistent quota or an unsupported read', () => {
    const raw = wire();
    expect(JSON.stringify(readOwnerControls({ ...raw, owner: 'other', data: { ...raw.data, code_hash: 'secret', invites: [{ ...row, raw_code: 'secret' }] } }, 'invites'))).not.toContain('secret');
    expect(() => readOwnerControls({ ...raw, data: { ...raw.data, issued: 5 } }, 'invites')).toThrow();
    expect(() => readOwnerControls({ ...raw, state: 'unavailable' }, 'invites')).toThrow();
    expect(() => readOwnerControls(raw, 'account')).toThrow();
  });
  it('validates one-time signup fragments and refuses foreign or replayed codes', () => {
    expect(readOwnerResult(creation(), 'https://console.example').invite?.code).toBe(creation().invite.code);
    expect(() => readOwnerResult({ ...creation(), duplicate: true }, 'https://console.example')).toThrow();
    for (const link of ['https://evil.example/console/signup#email=recipient%40example.com&invite=ABCDEFGHJKLMNPQRSTU2', 'https://console.example/console/signup?invite=ABCDEFGHJKLMNPQRSTU2', 'https://console.example/console/signup#email=wrong%40example.com&invite=ABCDEFGHJKLMNPQRSTU2']) expect(() => readOwnerResult({ ...creation(), invite: { ...creation().invite, link } }, 'https://console.example')).toThrow();
  });
  it('renders the current response only, with copy fields and no fake resend', () => {
    const html = renderToStaticMarkup(<OwnerReceipt result={readOwnerResult(creation(), 'https://console.example')} onDismiss={() => {}}/>);
    expect(html).toContain('Copy this one-time invite now'); expect(html).toContain('readOnly=""'); expect(html).toContain('shown only in this creation response'); expect(html).toContain('No email was sent');
    const replay = renderToStaticMarkup(<OwnerReceipt result={{ duplicate: true, receipt: { state: 'recorded', message: 'The code cannot be recovered.' } }} onDismiss={() => {}}/>);
    expect(replay).not.toContain(creation().invite.code); expect(replay).toContain('same request did not run again');
  });
});
describe('account removal', () => {
  it('requires typed deliberate confirmation and never claims every retained byte is purged', () => {
    const record = readOwnerControls(wire('account'), 'account') as Extract<OwnerRead, { view: 'account' }>;
    const html = renderToStaticMarkup(<AccountRemoval record={record} busy={false} blocked={false} onSubmit={() => {}}/>);
    expect(html).toContain('Type DELETE to confirm'); expect(html).toContain('disabled=""'); expect(html).toContain('cannot be undone'); expect(html).toContain('retained copies are not certified purged');
    const receipt = renderToStaticMarkup(<OwnerReceipt result={{ duplicate: false, receipt: { state: 'incomplete', signed_out: true, message: 'Local removal could not be confirmed.' } }} onDismiss={() => {}}/>);
    expect(receipt).toContain('Local removal could not be confirmed'); expect(receipt).toContain('/console/signin');
  });
});
describe('owner control transport', () => {
  it('uses owner-scoped no-store reads with cancellation and an explicit sign-in state', async () => {
    const mock = vi.fn(async () => Response.json(wire())); vi.stubGlobal('fetch', mock);
    const signal = new AbortController().signal;
    expect(await fetchOwnerControls('invites', signal)).toMatchObject({ view: 'invites' });
    expect(mock).toHaveBeenCalledWith('/console/dashboard/api/v1/owner?view=invites', expect.objectContaining({ credentials: 'same-origin', signal, cache: 'no-store' }));
    mock.mockResolvedValue(new Response(null, { status: 401 })); await expect(fetchOwnerControls('invites', signal)).rejects.toThrow('Sign in');
  });
  it('sends fixed revision-bound actions and distinguishes refused from unknown results without exposing raw errors', async () => {
    const mock = vi.fn(async () => Response.json(creation())); vi.stubGlobal('fetch', mock);
    const attempt = { record: readOwnerControls(wire(), 'invites'), value: 'recipient@example.com', confirmation: '', id: 'request-00001' };
    expect((await submitOwnerControl(attempt, 'https://console.example')).invite?.code).toBe(creation().invite.code);
    const calls = mock.mock.calls as unknown as [string, RequestInit][];
    const form = calls[0]![1].body as FormData;
    expect(calls[0]![0]).toBe('/console/dashboard/api/v1/owner/actions');
    expect(form.get('csrf')).toBe('session-csrf'); expect(form.get('revision')).toBe(revision); expect(form.get('request_id')).toBe(attempt.id); expect(form.has('owner')).toBe(false);
    mock.mockResolvedValue(Response.json({ error: 'stale_read', private_detail: 'secret' }, { status: 409 }));
    await expect(submitOwnerControl(attempt, 'https://console.example')).rejects.toBeInstanceOf(OwnerChangeError);
    mock.mockResolvedValue(Response.json({ error: 'secret' }, { status: 503 }));
    await expect(submitOwnerControl(attempt, 'https://console.example')).rejects.toThrow('outcome could not be confirmed');
  });
});
