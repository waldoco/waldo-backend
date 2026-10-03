import { useEffect, useRef, useState } from 'react';
import { SignInRequired } from './model';

export type OwnerView = 'invites' | 'account';
type InviteRow = { email: string | null; created_at: string; expires_at: string | null; used_at: string | null; revoked_at: string | null };
type Base = { version: 1; state: 'available'; csrf: string; revision: string };
export type OwnerRead = Base & ({ view: 'invites'; data: { issued: number; limit: 5; creation_available: boolean; expiry_days: 14; invites: InviteRow[] } } | { view: 'account'; data: { deletion_available: boolean } });
export type OwnerResult = { duplicate: boolean; receipt: { state: 'recorded' | 'incomplete' | 'rejected' | 'unconfirmed'; message: string; signed_out?: boolean }; invite?: { email: string; code: string; link: string; expiry_days: 14 } };
const READ_PATH = '/console/dashboard/api/v1/owner';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const nullable = (value: unknown): value is string | null => value === null || text(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const readFailure = () => new Error('These owner controls are unavailable. Refresh the records.');
export class OwnerChangeError extends Error { constructor(message: string, readonly uncertain: boolean) { super(message); } }
export function readOwnerControls(raw: unknown, view: OwnerView): OwnerRead {
  if (!object(raw) || raw.version !== 1 || raw.view !== view || raw.state !== 'available' || !text(raw.csrf) || !raw.csrf || !text(raw.revision) || !/^[0-9a-f]{64}$/.test(raw.revision) || !object(raw.data)) throw readFailure();
  const base: Base = { version: 1, state: 'available', csrf: raw.csrf, revision: raw.revision }, data = raw.data;
  if (view === 'account') {
    if (typeof data.deletion_available !== 'boolean') throw readFailure();
    return { ...base, view, data: { deletion_available: data.deletion_available } };
  }
  if (!count(data.issued) || data.limit !== 5 || data.expiry_days !== 14 || typeof data.creation_available !== 'boolean' || !Array.isArray(data.invites) || data.issued !== data.invites.length || data.creation_available !== (data.issued < 5)) throw readFailure();
  const invites = data.invites.map(row => {
    if (!object(row) || !nullable(row.email) || !text(row.created_at) || !nullable(row.expires_at) || !nullable(row.used_at) || !nullable(row.revoked_at)) throw readFailure();
    return { email: row.email, created_at: row.created_at, expires_at: row.expires_at, used_at: row.used_at, revoked_at: row.revoked_at };
  });
  return { ...base, view, data: { issued: data.issued, limit: 5, creation_available: data.creation_available, expiry_days: 14, invites } };
}
export async function fetchOwnerControls(view: OwnerView, signal: AbortSignal): Promise<OwnerRead> {
  const result = await fetch(`${READ_PATH}?view=${view}`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal, headers: { accept: 'application/json' } });
  if (result.status === 401) throw new SignInRequired();
  if (!result.ok) throw readFailure();
  return readOwnerControls(await result.json(), view);
}
export function readOwnerResult(raw: unknown, origin: string): OwnerResult {
  if (!object(raw) || typeof raw.duplicate !== 'boolean' || !object(raw.receipt) || !['recorded', 'incomplete', 'rejected', 'unconfirmed'].includes(String(raw.receipt.state)) || !text(raw.receipt.message) || (raw.receipt.signed_out !== undefined && typeof raw.receipt.signed_out !== 'boolean')) throw new Error('The request outcome could not be confirmed. Inspect the records before any new request.');
  const receipt: OwnerResult['receipt'] = { state: raw.receipt.state as OwnerResult['receipt']['state'], message: raw.receipt.message, ...(raw.receipt.signed_out === true ? { signed_out: true } : {}) };
  let invite: OwnerResult['invite'];
  if (raw.invite !== undefined) {
    const value = raw.invite;
    if (!object(value) || !text(value.email) || !text(value.code) || !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{20}$/.test(value.code) || !text(value.link) || value.expiry_days !== 14 || receipt.state !== 'recorded' || raw.duplicate) throw new Error('The one-time invite response is unavailable. Do not create it again automatically.');
    const link = new URL(value.link), expected = new URL('/console/signup', origin);
    const fields = new URLSearchParams(link.hash.slice(1));
    if (link.origin !== expected.origin || link.pathname !== expected.pathname || link.search || fields.getAll('email').length !== 1 || fields.getAll('invite').length !== 1 || [...fields.keys()].some(key => !['email', 'invite'].includes(key)) || fields.get('invite') !== value.code || fields.get('email') !== value.email.trim().toLowerCase()) throw new Error('The one-time invite destination could not be confirmed.');
    invite = { email: value.email, code: value.code, link: value.link, expiry_days: 14 };
  }
  return { duplicate: raw.duplicate, receipt, ...(invite ? { invite } : {}) };
}
type Attempt = { record: OwnerRead; value: string; confirmation: string; id: string };
export async function submitOwnerControl(attempt: Attempt, origin: string): Promise<OwnerResult> {
  const form = new FormData();
  for (const [key, value] of Object.entries({ csrf: attempt.record.csrf, view: attempt.record.view, revision: attempt.record.revision, request_id: attempt.id, action: attempt.record.view === 'invites' ? 'invite.member' : 'account.delete', value: attempt.value, ...(attempt.record.view === 'account' ? { confirmation: attempt.confirmation } : {}) })) form.set(key, value);
  const result = await fetch(`${READ_PATH}/actions`, { method: 'POST', body: form, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' } });
  if (result.status === 401) throw new SignInRequired();
  let raw: unknown; try { raw = await result.json(); } catch { throw new Error('The request outcome is unconfirmed. Check this request before any new creation.'); }
  if (result.status === 403 || result.status === 400 || result.status === 429 || (result.status === 409 && (!object(raw) || !raw.receipt))) throw new OwnerChangeError('The change was refused or these records changed. Refresh and review before making a new request.', false);
  const decoded = readOwnerResult(raw, origin);
  if (!result.ok && !((result.status === 409 && decoded.receipt.state === 'rejected') || (result.status === 503 && ['unconfirmed', 'incomplete'].includes(decoded.receipt.state)))) throw new Error('The request outcome is unconfirmed. Inspect the records before any new request.');
  return decoded;
}
export const memberInviteStatus = (row: InviteRow, now: number) => row.used_at ? 'Used' : row.revoked_at ? 'Revoked' : row.expires_at && Date.parse(row.expires_at) <= now ? 'Expired' : 'Pending';

export function MemberInvites({ record, busy, blocked, onSubmit }: { record: Extract<OwnerRead, { view: 'invites' }>; busy: boolean; blocked: boolean; onSubmit: (email: string) => void }) {
  const [email, setEmail] = useState('');
  return <>
    <section className="panel"><h2>Invite someone to Waldo.</h2><p>{record.data.issued} of 5 total invites issued. Used, expired and revoked invites still count toward this limit.</p><p>Each code lasts 14 days, works once, and is bound to its recipient’s email. Copy the link when it appears and send it yourself. Waldo does not email or resend it.</p><p className="muted">An invite lets someone join Waldo; it does not share your owner data or make them a trusted person. Signup follows Waldo’s available verification flow.</p>
      {record.data.creation_available ? <form className="control-form" onSubmit={event => { event.preventDefault(); if (!busy && !blocked) onSubmit(email); }}><label>Recipient email<input name="email" type="email" autoComplete="email" required value={email} disabled={busy || blocked} onChange={event => setEmail(event.target.value)}/></label><button disabled={busy || blocked}>Create one-time invite</button></form> : <p>You have used all five invites.</p>}
      {blocked && <p role="alert">A previous creation is unresolved or its one-time code is unavailable. Inspect the issued history; do not recreate the same invite blindly.</p>}
    </section>
    <section className="panel"><h2>Issued invites</h2>{record.data.invites.length ? <div className="owner-invite-list">{record.data.invites.map((row, index) => <article className="activity-record" key={`${row.created_at}:${index}`}><h3>{row.email ?? 'Recipient email unavailable'}</h3><p>{memberInviteStatus(row, Date.now())}</p><p className="muted">Created {row.created_at} · Expires {row.expires_at ?? 'unavailable'}</p>{row.used_at && <p>Use recorded {row.used_at}</p>}{row.revoked_at && <p>Revocation recorded {row.revoked_at}</p>}</article>)}</div> : <p>No issued invites returned.</p>}<p className="muted">Stored codes are hashed and cannot be recovered here. A pending invite is not proof of delivery or completed signup.</p></section>
  </>;
}
export function AccountRemoval({ record, busy, blocked, onSubmit }: { record: Extract<OwnerRead, { view: 'account' }>; busy: boolean; blocked: boolean; onSubmit: (confirmation: string) => void }) {
  const [confirmation, setConfirmation] = useState('');
  return <section className="panel owner-account-danger"><h2>Delete your Waldo account</h2><p>This removes the owner directory entry and requests deletion of this owner’s local storage, memory, settings and connections. This cannot be undone.</p><p>Telegram-hosted files and other retained copies are not certified purged by this operation. Deletion is different from signing out.</p>{blocked && <p role="alert">The previous removal outcome needs review. Check the same request before trying another deletion.</p>}{record.data.deletion_available ? <form className="control-form" onSubmit={event => { event.preventDefault(); if (!busy && !blocked && confirmation === 'DELETE') onSubmit(confirmation); }}><label>Type DELETE to confirm<input autoComplete="off" value={confirmation} disabled={busy || blocked} onChange={event => setConfirmation(event.target.value)}/></label><button disabled={busy || blocked || confirmation !== 'DELETE'}>Delete account</button></form> : <p>Account removal is unavailable on this server.</p>}</section>;
}
export function OwnerReceipt({ result, onDismiss }: { result: OwnerResult; onDismiss: () => void }) {
  return <section className="panel control-receipt" role={result.receipt.state === 'recorded' ? 'status' : 'alert'}><h2>{result.receipt.signed_out ? 'Signed out.' : result.receipt.state === 'recorded' ? 'Receipt recorded.' : result.receipt.state === 'incomplete' ? 'Removal incomplete.' : result.receipt.state === 'rejected' ? 'Change refused.' : 'Outcome unconfirmed.'}</h2><p>{result.receipt.message}</p>{result.duplicate && <p>The same request did not run again. One-time codes are never recovered from stored receipts.</p>}{result.invite && <div className="owner-invite-code"><h3>Copy this one-time invite now</h3><p>For {result.invite.email}. Expires 14 days after creation. No email was sent.</p><label>Signup link<input readOnly value={result.invite.link} onFocus={event => event.currentTarget.select()}/></label><label>Invite code<input readOnly value={result.invite.code} onFocus={event => event.currentTarget.select()}/></label><p className="muted">This code is shown only in this creation response. Leaving or dismissing it loses the recoverable copy.</p><button onClick={onDismiss}>Dismiss one-time code</button></div>}{result.receipt.signed_out && <a href="/console/signin">Sign in</a>}</section>;
}
export function OwnerControlsPanel({ view, embedded=false }: { view: OwnerView; embedded?:boolean }) {
  const [read, setRead] = useState<OwnerRead | null>(null), [failure, setFailure] = useState<string | null>(null), [signedOut, setSignedOut] = useState(false);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0), [busy, setBusy] = useState(false), [result, setResult] = useState<OwnerResult | null>(null), [blocked, setBlocked] = useState(false);
  const attempt = useRef<Attempt | null>(null), inFlight = useRef(false), generation = useRef(0);
  useEffect(() => {
    const abort = new AbortController(); setRead(null); setFailure(null);
    fetchOwnerControls(view, abort.signal).then(value => { if (!abort.signal.aborted) setRead(value); }).catch(error => { if (!abort.signal.aborted) { setFailure(error instanceof SignInRequired ? 'Sign in to open your owner controls.' : 'Owner controls are unavailable. Retry the read.'); setSignedOut(error instanceof SignInRequired); } });
    return () => abort.abort();
  }, [view, retry]);
  useEffect(() => { generation.current++; setResult(null); setActionFailure(null); setBlocked(false); setSignedOut(false); setBusy(false); attempt.current = null; return () => { generation.current++; }; }, [view]);
  const send = async (value: Attempt) => {
    if (inFlight.current) return;
    const active = generation.current; inFlight.current = true; setBusy(true); setActionFailure(null);
    try {
      const receipt = await submitOwnerControl(value, window.location.origin);
      if (generation.current !== active) return;
      setResult(receipt); setBlocked(receipt.receipt.state === 'unconfirmed' || (value.record.view === 'invites' && receipt.receipt.state === 'recorded' && !receipt.invite));
      if (receipt.receipt.signed_out) { setSignedOut(true); setRead(null); }
      else setRetry(number => number + 1);
    } catch (error) {
      if (generation.current !== active) return;
      const expired = error instanceof SignInRequired;
      setActionFailure(expired ? 'Sign in to inspect the request outcome.' : error instanceof OwnerChangeError ? error.message : 'The request outcome is unconfirmed. Check the same request before any new creation or removal.');
      setSignedOut(expired); setBlocked(!(error instanceof OwnerChangeError) || error.uncertain); setRead(null); if (!expired) setRetry(number => number + 1);
    } finally { inFlight.current = false; if (generation.current === active) setBusy(false); }
  };
  const start = (value: string, confirmation = '') => { if (!read || inFlight.current || blocked) return; const next = { record: read, value, confirmation, id: crypto.randomUUID() }; attempt.current = next; setResult(null); void send(next); };
  return <>{!embedded&&<div className="controls-section-heading"><span className="eyebrow">{view === 'invites' ? 'Bring someone along' : 'Owner control'}</span><h1>{view === 'invites' ? 'Invites.' : 'Account.'}</h1></div>}{result && <OwnerReceipt result={result} onDismiss={() => setResult(previous => previous ? { ...previous, invite: undefined } : null)}/>}{actionFailure && <section className="panel" role="alert"><p>{actionFailure}</p>{signedOut && <a href="/console/signin">Sign in</a>}</section>}{failure && <section className="panel" role="alert"><p>{failure}</p>{signedOut ? <a href="/console/signin">Sign in</a> : <button disabled={busy} onClick={() => setRetry(number => number + 1)}>Retry read</button>}</section>}{blocked && !signedOut && attempt.current && <button disabled={busy} onClick={() => void send(attempt.current!)}>Check the same request</button>}{!read && !failure && !signedOut && <p role="status">Reading your {view}…</p>}{read && !signedOut && (read.view === 'invites' ? <MemberInvites key={read.revision} record={read} busy={busy} blocked={blocked} onSubmit={email => start(email)}/> : <AccountRemoval key={read.revision} record={read} busy={busy} blocked={blocked} onSubmit={confirmation => start('', confirmation)}/>)}{!signedOut && <button disabled={busy} onClick={() => setRetry(number => number + 1)}>Refresh owner controls</button>}</>;
}
