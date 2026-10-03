import { describe, expect, it, vi } from 'vitest';
import { ownerControlsAction, ownerControlsRead, ownerControlsView, type OwnerControlsDeps } from '../src/channels/dashboard-owner-controls';
const row = { email: 'recipient@example.com', created_at: '2026-10-01T00:00:00Z', expires_at: '2026-10-15T00:00:00Z', used_at: null as string | null, revoked_at: null as string | null };
function setup() {
  const stored = new Map<string, unknown>();
  const auth = { memberInvites: vi.fn(async () => [row]), memberInvite: vi.fn(async () => true), deleteOwner: vi.fn(async () => true) };
  const put = vi.fn(async (key: string, value: unknown) => { stored.set(key, JSON.parse(JSON.stringify(value))); });
  const deps: OwnerControlsDeps = { owner: 'trusted-owner', csrf: 'current-csrf', expires: Date.now() + 43200000, auth, requestUrl: 'https://console.example/console/dashboard',
    sessions: async () => [{ csrf: 'current-csrf', expires: Date.now() + 43200000 }], store: { get: async <T>(key: string) => stored.get(key) as T | undefined, put }, eraseOwnerStorage: vi.fn(async () => { stored.clear(); }) };
  return { deps, auth, stored, put };
}
async function form(deps: OwnerControlsDeps, view: 'invites' | 'account' = 'invites') {
  const read = await (await ownerControlsRead(view, deps)).json() as { revision: string };
  const result = new FormData();
  for (const [key, value] of Object.entries({ csrf: deps.csrf, action: view === 'invites' ? 'invite.member' : 'account.delete', value: 'recipient@example.com', view, revision: read.revision, request_id: 'request-00001', ...(view === 'account' ? { confirmation: 'DELETE' } : {}) })) result.set(key, value);
  return result;
}
describe('owner invites and account read contracts', () => {
  it('accepts only fixed views and refuses owner selectors or duplicated parameters', () => {
    expect(ownerControlsView(new URLSearchParams('view=invites'))).toBe('invites');
    expect(ownerControlsView(new URLSearchParams('view=account'))).toBe('account');
    for (const query of ['view=admin', 'view=invites&owner=other', 'view=account&view=account', '']) expect(ownerControlsView(new URLSearchParams(query))).toBeNull();
  });
  it('projects only safe issued rows and counts expired, used and revoked toward five', async () => {
    const { deps, auth } = setup();
    auth.memberInvites.mockResolvedValue(Array.from({ length: 5 }, (_, i) => ({ ...row, used_at: i === 0 ? row.created_at : null, revoked_at: i === 1 ? row.created_at : null, code: 'never-project', code_hash: 'never-project' })));
    const result = await ownerControlsRead('invites', deps), body = await result.json();
    expect(body).toMatchObject({ version: 1, view: 'invites', state: 'available', data: { issued: 5, limit: 5, creation_available: false, expiry_days: 14 } });
    expect(JSON.stringify(body)).not.toContain('never-project');
    expect(auth.memberInvites).toHaveBeenCalledWith('trusted-owner');
    expect(result.headers.get('cache-control')).toContain('no-store');
  });
  it('reports unavailable reads rather than an empty list or an enabled delete', async () => {
    const { deps, auth } = setup();
    auth.memberInvites.mockRejectedValue(new Error('private database detail'));
    expect((await ownerControlsRead('invites', deps)).status).toBe(503);
    deps.auth = null;
    expect((await ownerControlsRead('account', deps)).status).toBe(503);
  });
});
describe('owner member-invite actions', () => {
  it('binds CSRF, read revision and trusted owner before issuing', async () => {
    const { deps, auth } = setup(), request = await form(deps);
    request.set('csrf', 'wrong'); expect((await ownerControlsAction(request, deps)).status).toBe(403);
    request.set('csrf', deps.csrf); request.set('revision', 'old'); expect((await ownerControlsAction(request, deps)).status).toBe(409);
    request.set('owner', 'other'); expect((await ownerControlsAction(request, deps)).status).toBe(400);
    expect(auth.memberInvite).not.toHaveBeenCalled();
  });
  it('shows code only in the first response, never persists it or the signup link, and does not reissue on replay', async () => {
    const { deps, auth, stored } = setup(), request = await form(deps);
    const first = await (await ownerControlsAction(request, deps)).json() as { invite: { code: string; link: string } };
    expect(first.invite.code).toHaveLength(20);
    expect(new URL(first.invite.link).pathname).toBe('/console/signup');
    expect(new URL(first.invite.link).search).toBe('');
    expect(new URL(first.invite.link).hash).toContain(first.invite.code);
    expect(auth.memberInvite).toHaveBeenCalledWith('trusted-owner', 'recipient@example.com', first.invite.code);
    expect(JSON.stringify([...stored])).not.toContain(first.invite.code);
    expect(JSON.stringify([...stored])).not.toContain(first.invite.link);
    const duplicate = await (await ownerControlsAction(request, deps)).json();
    expect(duplicate).toMatchObject({ duplicate: true, receipt: { state: 'recorded' } });
    expect(duplicate).not.toHaveProperty('invite');
    expect(auth.memberInvite).toHaveBeenCalledTimes(1);
  });
  it('journals uncertainty before the effect and never blindly repeats a lost creation', async () => {
    const { deps, auth } = setup(), request = await form(deps);
    auth.memberInvite.mockRejectedValue(new Error('secret outcome'));
    expect((await ownerControlsAction(request, deps)).status).toBe(503);
    const duplicate = await ownerControlsAction(request, deps);
    const body = await duplicate.json();
    expect(body).toMatchObject({ duplicate: true, receipt: { state: 'unconfirmed' } });
    expect(JSON.stringify(body)).not.toContain('secret outcome');
    expect(auth.memberInvite).toHaveBeenCalledTimes(1);
  });
  it('refuses exhausted quota and rejects false executor results without creating a code response', async () => {
    const { deps, auth } = setup();
    auth.memberInvites.mockResolvedValue(Array.from({ length: 5 }, () => row));
    expect((await ownerControlsAction(await form(deps), deps)).status).toBe(409);
    expect(auth.memberInvite).not.toHaveBeenCalled();
    auth.memberInvites.mockResolvedValue([row]); auth.memberInvite.mockResolvedValue(false);
    const denied = await ownerControlsAction(await form(deps), deps);
    expect(denied.status).toBe(409); expect(await denied.json()).not.toHaveProperty('invite');
  });
});
describe('owner account removal actions', () => {
  it('requires deliberate confirmation and preserves existing directory then owner-storage deletion order', async () => {
    const { deps, auth, put, stored } = setup(), request = await form(deps, 'account');
    request.delete('confirmation'); expect((await ownerControlsAction(request, deps)).status).toBe(400);
    expect(auth.deleteOwner).not.toHaveBeenCalled(); request.set('confirmation', 'DELETE');
    const result = await ownerControlsAction(request, deps), body = await result.json();
    expect(body).toMatchObject({ receipt: { state: 'recorded', signed_out: true } });
    expect(JSON.stringify(body)).toContain('does not verify that every retained copy or file byte has been purged');
    expect(auth.deleteOwner).toHaveBeenCalledWith('trusted-owner');
    expect(vi.mocked(deps.eraseOwnerStorage).mock.invocationCallOrder[0]).toBeGreaterThan(auth.deleteOwner.mock.invocationCallOrder[0]!);
    expect(put).toHaveBeenCalledTimes(1); expect(stored.size).toBe(0);
  });
  it('keeps refused deletion distinct from partial local removal, without certifying purge', async () => {
    const { deps, auth } = setup(); auth.deleteOwner.mockResolvedValue(false);
    expect((await ownerControlsAction(await form(deps, 'account'), deps)).status).toBe(409);
    expect(deps.eraseOwnerStorage).not.toHaveBeenCalled();
    const next = setup(); vi.mocked(next.deps.eraseOwnerStorage).mockRejectedValue(new Error('private storage error'));
    const body = await (await ownerControlsAction(await form(next.deps, 'account'), next.deps)).json();
    expect(body).toMatchObject({ receipt: { state: 'incomplete', signed_out: true } });
    expect(JSON.stringify(body)).not.toContain('private storage error');
    expect(JSON.stringify(body)).toContain('not certified purged');
  });
});
