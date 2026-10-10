// FIXTURE (SOURCE/local): an in-memory model of the waldo.imessage_* router-signed functions,
// used only by the Workers-pool tests. It verifies every router signature and locator exactly as
// the SQL does. Real PostgreSQL behavior is proven separately by supabase/tests/waldo_imessage_connector.sql
// and by scripts/imessage-local-trace.mjs against a disposable database.
import { routerSignature } from '../../src/identity/owner-directory';
import { sha256Hex } from '../../src/channels/imessage/crypto';

export type FixtureBridge = {
  bridge_id: string; account_id: string; owner: string; environment: string; state: 'pending' | 'active' | 'revoked';
  wrapped_credential: string; revision: number; pending_expires_at: number; host_version: string;
  expected_subject: string | null; expected_chat_guid: string | null; challenge_hash: string | null; challenge_expires_at: number | null;
  observed: { subject: string; chat: string; at: number } | null; presence_id: string | null;
};
export type FixtureOwner = { do_name: string; owner_id: string; state: 'active' | 'suspended'; state_version: number; admission_revision: number };

export function fixtureDirectory(input: { origin: string; secret: string; owners: FixtureOwner[]; extra?: (fn: string, args: Record<string, unknown>) => Response | Promise<Response> | null }) {
  const invitations = new Map<string, { owner: string; environment: string; expires: number; used: boolean }>();
  const bridges = new Map<string, FixtureBridge>();
  const presences = new Map<string, { id: string; owner: string; subject: string; active: boolean }>();
  const calls: string[] = [];
  let seq = 1;
  let unavailable = false;
  const owner = (doName: string) => input.owners.find((o) => o.do_name === doName);
  const ownerOf = (b: FixtureBridge) => input.owners.find((o) => o.do_name === b.owner);
  const authority = (b: FixtureBridge) => {
    const o = ownerOf(b)!; const p = b.presence_id ? presences.get(b.presence_id) : undefined;
    const now = Date.now();
    const state = o.state !== 'active' ? 'owner_inactive' : b.state === 'pending' && now >= Math.max(b.pending_expires_at, b.challenge_expires_at ?? 0) ? 'expired'
      : b.state === 'active' && !p?.active ? 'revoked' : b.state;
    return { state, bridge_id: b.bridge_id, account_id: b.account_id, owner_id: o.owner_id, do_name: o.do_name, wrapped_credential: b.wrapped_credential, credential_epoch: 1,
      revision: `${b.revision}.${o.state_version}.${o.admission_revision}`, presence_id: b.state === 'active' ? b.presence_id : null, subject: p?.subject ?? null,
      chat_guid: b.state === 'active' ? b.expected_chat_guid : null,
      challenge_hash: b.state === 'pending' && !b.observed && (b.challenge_expires_at ?? 0) > now ? b.challenge_hash : null,
      expected_subject: b.state === 'pending' ? b.expected_subject : null, expected_chat_guid: b.state === 'pending' ? b.expected_chat_guid : null };
  };
  const handlers: Record<string, (a: Record<string, any>) => unknown> = {
    imessage_throttle: () => true,
    imessage_issue_invitation: (a) => { const o = owner(a.p_do_name); if (!o || o.state !== 'active') return false; invitations.set(a.p_code_hash, { owner: a.p_do_name, environment: a.p_environment, expires: Date.now() + a.p_lifetime_seconds * 1000, used: false }); return true; },
    imessage_redeem_invitation: (a) => {
      const i = invitations.get(a.p_code_hash); if (!i || i.used || i.expires <= Date.now() || i.environment !== a.p_environment) return null;
      i.used = true; const exp = Date.now() + a.p_pending_seconds * 1000;
      bridges.set(a.p_bridge_id, { bridge_id: a.p_bridge_id, account_id: a.p_account_id, owner: i.owner, environment: a.p_environment, state: 'pending', wrapped_credential: a.p_wrapped_credential,
        revision: seq++, pending_expires_at: exp, host_version: a.p_host_version, expected_subject: null, expected_chat_guid: null, challenge_hash: null, challenge_expires_at: null, observed: null, presence_id: null });
      return { bridge_id: a.p_bridge_id, account_id: a.p_account_id, do_name: i.owner, expires_at_ms: exp };
    },
    imessage_bridge_authority: (a) => { const b = bridges.get(a.p_bridge_id); return b && b.account_id === a.p_account_id && b.environment === a.p_environment ? authority(b) : null; },
    imessage_set_expected_scope: (a) => {
      const b = bridges.get(a.p_bridge_id); if (!b || b.owner !== a.p_do_name || b.state !== 'pending' || !String(a.p_chat_guid).startsWith('iMessage;-;')) return false;
      Object.assign(b, { expected_subject: a.p_subject, expected_chat_guid: a.p_chat_guid, challenge_hash: a.p_challenge_hash, challenge_expires_at: Date.now() + a.p_lifetime_seconds * 1000, observed: null, revision: seq++ });
      return true;
    },
    imessage_record_challenge: (a) => {
      const b = bridges.get(a.p_bridge_id);
      if (!b || b.account_id !== a.p_account_id || b.state !== 'pending' || b.observed || b.challenge_hash !== a.p_challenge_hash || (b.challenge_expires_at ?? 0) <= Date.now()
        || b.expected_subject !== a.p_subject || b.expected_chat_guid !== a.p_chat_guid) return false;
      b.observed = { subject: a.p_subject, chat: a.p_chat_guid, at: Date.now() }; return true;
    },
    imessage_activate: (a) => {
      const b = bridges.get(a.p_bridge_id), o = owner(a.p_do_name);
      if (!b || !o || o.state !== 'active' || b.owner !== a.p_do_name || b.state !== 'pending' || !b.observed || (b.challenge_expires_at ?? 0) <= Date.now()
        || b.observed.subject !== a.p_subject || b.observed.chat !== a.p_chat_guid) return null;
      if ([...bridges.values()].some((x) => x.owner === b.owner && x.state === 'active')) return null;
      if ([...presences.values()].some((p) => p.active && p.subject === b.observed!.subject)) return null;
      const id = crypto.randomUUID(); presences.set(id, { id, owner: b.owner, subject: b.observed.subject, active: true });
      o.admission_revision++; Object.assign(b, { state: 'active', presence_id: id, challenge_hash: null, revision: seq++ });
      return { bridge_id: b.bridge_id, account_id: b.account_id, presence_id: id, subject: b.observed.subject, chat_guid: b.observed.chat };
    },
    imessage_revoke: (a) => {
      const b = bridges.get(a.p_bridge_id); if (!b || b.owner !== a.p_do_name || (b.state !== 'pending' && b.state !== 'active')) return false;
      const p = b.presence_id ? presences.get(b.presence_id) : undefined; if (p) p.active = false;
      Object.assign(b, { state: 'revoked', presence_id: null, challenge_hash: null, revision: seq++ }); return true;
    },
    imessage_list: (a) => [...bridges.values()].filter((b) => b.owner === a.p_do_name).map((b) => ({ bridge_id: b.bridge_id, account_id: b.account_id, state: b.state,
      subject: b.expected_subject, chat_guid: b.expected_chat_guid, observed: !!b.observed, host_version: b.host_version, created_at: 'fixture', activated_at: null, revoked_at: null })),
    route_presence: (a) => {
      const p = [...presences.values()].find((x) => x.active && x.subject === a.p_subject); const o = p ? owner(p.owner) : undefined;
      return a.p_provider === 'imessage' && p && o && o.state === 'active' ? [{ do_name: o.do_name, subject: p.subject, timezone: 'UTC', owner_id: o.owner_id, owner_email: null }] : [];
    },
  };
  const signedMessage = async (fn: string, a: Record<string, any>) => {
    if (fn === 'route_presence') return `route.${a.p_provider}.${a.p_subject}`;
    const op = ({ imessage_throttle: 'throttle', imessage_issue_invitation: 'invite', imessage_redeem_invitation: 'redeem', imessage_bridge_authority: 'authority',
      imessage_set_expected_scope: 'scope', imessage_record_challenge: 'challenge', imessage_activate: 'activate', imessage_revoke: 'revoke', imessage_list: 'list' } as Record<string, string>)[fn];
    if (!op) return null;
    const { p_at: _at, p_sig: _sig, p_locator, ...params } = a;
    // The SQL re-derives the locator from its parameters before trusting the signature.
    if (JSON.stringify(JSON.parse(p_locator)) !== JSON.stringify(Object.values(params))) throw new Error('imessage locator mismatch');
    return `imsg.${op}.${await sha256Hex(p_locator)}`;
  };
  const fetcher = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response | null> => {
    const url = new URL(String(request instanceof Request ? request.url : request));
    if (url.origin !== input.origin || !url.pathname.startsWith('/rest/v1/rpc/')) return null;
    const fn = url.pathname.split('/').at(-1)!, a = JSON.parse(String(init?.body ?? (request instanceof Request ? await request.text() : '{}')));
    calls.push(fn);
    if (unavailable) return new Response('', { status: 503 });
    const message = await signedMessage(fn, a);
    if (message !== null) {
      if (a.p_sig !== await routerSignature(input.secret, a.p_at, message)) return Response.json({ code: '42501', message: 'unsigned router call' }, { status: 403 });
      return Response.json(handlers[fn]!(a));
    }
    const extra = await input.extra?.(fn, a);
    if (extra) return extra;
    throw new Error(`Unlisted fixture RPC ${fn}`);
  };
  return { fetcher, calls, bridges, presences, invitations, owners: input.owners, setUnavailable: (v: boolean) => { unavailable = v; } };
}
