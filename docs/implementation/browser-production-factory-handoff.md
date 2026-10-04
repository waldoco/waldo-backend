# Disabled browser production factory

Owner: isolated browser factory lane. Base: browser checkpoint 6789b8db.
Integration target inspected: beta-mvp 9d703d459303002312079e1592a5461e21802711.
The release lane owns TelegramOwnerDO, owner-turn, identity files, migrations and deployment configuration. None are edited here.

## Implemented boundary

`browserProductionConfiguration({ env, storage, actualDoId })` returns undefined immediately: no storage, directory or provider I/O. Its optional policy is trusted deployment code, never tool arguments or environment-variable activation. A configured disabled policy retains the concrete cleanup driver but refuses grants and allocation. Only staging and the exact policy DO/fixture origin are eligible.

The configured factory reads a private, strict `BrowserOwnerAuthorization` at `browser_owner_authorization_v1`, checks its manifest digest, reads canonical owner binding through existing signedRpc, verifies the physical namespace-derived DO ID and stored subject before and after the await, and builds the existing publicFixtureBrowser driver. There is no alternate owner identity or legacy route fallback.

The durable authority adapter cannot install, refresh, widen or synthesize consent. Its future writer must be an authenticated owner-confirmation handler. Authorization and usage are one durable record; missing/malformed records or counters deny rather than reset. Reservations occur in synchronous transactions before provider I/O. Limits can be reduced but never exceed 32 admissions, one allocation, a 60-second authorization window, or 120,000 reserved browser milliseconds. Reservation counts the requested session window plus one idle-timeout window for failed close/unknown allocation. Failed allocation never refunds capacity. Existing independent stop key, expiry, state/revision changes and replacement decisions fence the captured authority. This is a per-owner trial budget, not a global billing or concurrency cap.

Final submit still requires the checkpoint's exact stored proposal and atomically claimed approval desk row. Empty `act` evidence permits the existing service preflight; physical fill/submit checks carry action/state digests and submit approval evidence. Authority references are not effect receipts.

## Exact missing signed read contract (proposal only)

No available RPC returns the full PresenceBinding. Existing route_presence returns only do_name, subject and timezone; the workspace mapping supplies physical custody but not presence/revision. Do not fabricate missing fields or widen that route's public projection. Add this read-only RPC through the release writer, using existing router signing and owner mapping machinery:

```sql
create function waldo.browser_owner_binding(
  p_environment text, p_namespace text, p_do_name text, p_do_id text,
  p_provider text, p_subject text, p_locator text, p_at bigint, p_sig text
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if p_locator::jsonb is distinct from jsonb_build_array(
    p_environment,p_namespace,p_do_name,p_do_id,p_provider,p_subject) then
    raise exception 'browser locator mismatch' using errcode = '42501';
  end if;
  if not waldo.router_signed('browser.bind.' ||
    encode(extensions.digest(p_locator,'sha256'),'hex'),p_at,p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_environment is distinct from 'staging' or p_provider is distinct from 'telegram' then return null; end if;
  select jsonb_build_object('owner_id',o.id,'do_name',o.do_name,
    'state_version',o.state_version,'admission_revision',o.admission_revision::text,
    'presence_id',p.id,'provider',p.provider,'subject',p.subject)
  into v_result
  from waldo.owners o join waldo.presences p on p.owner_id=o.id
  join waldo.workspace_owner_mappings m on m.owner_id=o.id and m.do_name=o.do_name
  where o.do_name=p_do_name and o.state='active' and p.state='active'
    and p.provider=p_provider and p.subject=p_subject
    and m.environment=p_environment and m.namespace=p_namespace and m.do_id=p_do_id;
  return v_result;
end $$;
revoke all on function waldo.browser_owner_binding(text,text,text,text,text,text,text,bigint,text) from public,anon,authenticated;
grant execute on function waldo.browser_owner_binding(text,text,text,text,text,text,text,bigint,text) to anon;
```

This proposal does not provision a mapping, issue a grant or migrate anything. Missing prior workspace mapping remains unavailable. The factory tests verify exact request tuple/signature, strict response and legacy projection rejection. Before migration approval, SQL tests must cover invalid signature/tuple, foreign physical locator, suspended owner/presence, absent mapping and presence remove/re-add with a new admission revision. SQL proposal is not a deployed/tested database function.

## Release writer integration

Import the factory at the two-argument deployed constructor's host initialization, retain the default omitted policy, and await configured initialization inside DO readiness. Factory failure must disable only browser configuration, never block ordinary owner messaging. Instantiate the existing browserOwnerHost with the resulting configuration; preserve its physical checks, approval validation, handler composite, stop fence and alarm arbitration. The asynchronous factory requires readiness before handlers access that host. Do not replace its fresh lookup with cached constructor identity.

The current serving route still uses a Telegram numeric owner while browserOwnerHost expects the canonical `prn_<owner uuid>` principal. The writer must adopt the existing canonical ownerMessageAdmission path and pass its verified principal through dispatcher/approval boundaries, preserving N03 task scope. This patch does not modify those shared files or claim that serving integration is complete.

A future authenticated confirmation handler writes the complete authorization record, including exact binding/manifest, owner decision ref, active state, creation/expiry, explicitly authorized operations/budget and zeroed usage with authorizationRef equal to ref. No such handler is exposed here. Final submit approval remains separate. Expired/revoked configured records remain available to construct cleanup, but cannot grant new work.

## Remaining owner decision and proof

After source integration and review: one owner, one fresh self-contained HTTPS fixture, one session, 60 seconds of authorization, at most 32 admission checks/five existing mutating steps, 120 seconds reserved for session plus idle fallback, with final submit through the existing desk. No login/cookies/private persistence, new credential, plan upgrade, account-wide enablement or paid overage is authorized by source preparation. The existing $10 billing alert is not a hard cap. Binding/nodejs_compat activation and a bounded live trial require the owner's action-time authorization.

Live acceptance must show the actual serving owner turn, same-session reconnect across host reconstruction, fill, exact desk approval, one submit, authoritative fixture receipt, no replay and physical cleanup/zero active sessions. Local tests use synthetic directory/provider transport and do not establish live browser parity.
