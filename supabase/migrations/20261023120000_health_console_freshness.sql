-- Health freshness for the console: counts, timestamps, dates and closed codes only. Never a reading, a payload, an anchor,
-- a sample or request id, a signal name or a derived score. One projection, two authorities: the owner reads their own
-- through a signed health call, and the admin reads every owner's through a signed admin call.

-- A refused upload stores no receipt, so its closed code and HTTP status are counted here, per owner and UTC day. Only the
-- Worker writes it, after it has answered the upload; the count holds no part of the request. The health retention calls
-- keep 30 days of it, withdrawing storage purges the owner's counts, and deleting the owner deletes them.
create table waldo.health_ingest_refusals (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  day date not null,
  code text not null check (code in ('invalid_request','not_linked','consent_required','consent_withdrawn','epoch_conflict','idempotency_conflict','anchor_conflict','sample_conflict','unavailable')),
  status smallint not null check (status between 400 and 599),
  refusals integer not null check (refusals > 0),
  newest_at timestamptz not null,
  primary key (owner_id, day, code, status)
);
create index health_ingest_refusals_day on waldo.health_ingest_refusals(day);
alter table waldo.health_ingest_refusals enable row level security;
alter table waldo.health_ingest_refusals force row level security;
revoke all on table waldo.health_ingest_refusals from public, anon, authenticated, service_role;

create function waldo.health_refusal_note(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_body jsonb; v_day date := (now() at time zone 'UTC')::date;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.refusal_note.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 256 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(v_body) k) is distinct from array['code','status']
    or jsonb_typeof(v_body->'code') is distinct from 'string' or jsonb_typeof(v_body->'status') is distinct from 'number'
    or (v_body->>'code') not in ('invalid_request','not_linked','consent_required','consent_withdrawn','epoch_conflict','idempotency_conflict','anchor_conflict','sample_conflict','unavailable')
    or (v_body->>'status') !~ '^[45][0-9]{2}$' then return '{"error":"invalid_request"}'; end if;
  insert into waldo.health_ingest_refusals(owner_id, day, code, status, refusals, newest_at) values (v_owner, v_day, v_body->>'code', (v_body->>'status')::smallint, 1, now())
    on conflict (owner_id, day, code, status) do update set refusals = waldo.health_ingest_refusals.refusals + 1, newest_at = excluded.newest_at;
  return '{"noted":true}';
end $$;

-- The one projection. Callable by no client role: only the two signed reads below reach it.
create function waldo.health_freshness(p_owner uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'sources', coalesce((select jsonb_agg(jsonb_build_object(
        'source', u.source,
        'newest_upload_at', to_char(u.newest at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'uploads_7d', u.uploads_7d,
        'rejected_readings_7d', coalesce((select jsonb_agg(jsonb_build_object('reason', r.reason, 'count', r.n) order by r.reason)
          from (select x->>'reason' as reason, count(*)::int as n from waldo.health_requests q cross join lateral jsonb_array_elements(coalesce(q.response->'rejected', '[]')) x
                where q.owner_id = p_owner and q.operation = 'ingest' and q.response->>'source' = u.source and q.created_at > now() - interval '7 days'
                  and x->>'reason' in ('invalid_sample','unsupported_signal','revision_conflict')
                group by 1) r), '[]'::jsonb)) order by u.source)
      from (select q.response->>'source' as source, max(q.created_at) as newest, (count(*) filter (where q.created_at > now() - interval '7 days'))::int as uploads_7d
            from waldo.health_requests q where q.owner_id = p_owner and q.operation = 'ingest' and q.response->>'source' in ('apple','samsung','health_connect','whoop')
            group by 1) u), '[]'::jsonb),
    'refusals_7d', coalesce((select jsonb_agg(jsonb_build_object('code', f.code, 'status', f.status, 'count', f.n,
        'newest_at', to_char(f.newest at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by f.code, f.status)
      from (select code, status, sum(refusals)::int as n, max(newest_at) as newest from waldo.health_ingest_refusals
            where owner_id = p_owner and day > (now() at time zone 'UTC')::date - 7 group by 1, 2) f), '[]'::jsonb),
    'newest_derived', (select jsonb_build_object('day', c.day, 'compiled_at', to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      from public.health_context_daily c join waldo.owners o on o.auth_user_id = c.user_id join waldo.health_context_basis b on b.owner_id = o.id and b.day = c.day
      where o.id = p_owner order by c.day desc limit 1)) $$;
revoke all on function waldo.health_freshness(uuid) from public, anon, authenticated, service_role;

-- The owner's own freshness, for their console. It needs no health consent: it says only when uploads arrived and why
-- any were refused, and withdrawing storage purges both the receipts and the refusal counts it reads.
create function waldo.health_freshness_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.freshness_read.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if p_payload <> '{}' then return '{"error":"invalid_request"}'; end if;
  return jsonb_build_object('freshness', waldo.health_freshness(v_owner));
end $$;

-- Every owner's freshness and consent state, for the admin. Its own signed message, so no other admin signature opens it.
create function waldo.admin_health_freshness(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if waldo.router_signed('admin_health.' || p_do_name, p_at, p_sig) is distinct from true then raise exception 'unsigned router call' using errcode = '42501'; end if;
  if not waldo.is_admin(p_do_name) then return null; end if;
  return jsonb_build_object('owners', coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.id, 'email', o.email, 'state', o.state, 'created_at', o.created_at,
      'consents', coalesce((select jsonb_agg(jsonb_build_object('source', v->>'source', 'purpose', v->>'purpose', 'status', v->>'status',
          'granted_at', v->'granted_at', 'withdrawn_at', v->'withdrawn_at') order by s.source, s.purpose)
        from waldo.health_scopes s cross join lateral waldo.health_consent_view(s) v where s.owner_id = o.id), '[]'::jsonb),
      'freshness', waldo.health_freshness(o.id)) order by o.created_at) from waldo.owners o), '[]'::jsonb));
end $$;

revoke all on function waldo.health_refusal_note(text,text,bigint,text), waldo.health_freshness_read(text,text,bigint,text), waldo.admin_health_freshness(text,bigint,text)
  from public, anon, authenticated, service_role;
grant execute on function waldo.health_refusal_note(text,text,bigint,text), waldo.health_freshness_read(text,text,bigint,text), waldo.admin_health_freshness(text,bigint,text) to anon;

-- Refusal counts are not kept by source (a refused body may never have been read), so withdrawing storage for any source
-- purges all of the owner's counts. A withdrawal is the only in-place change a consent row allows.
create function waldo.health_refusals_purge_on_withdrawal() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from waldo.health_ingest_refusals where owner_id = new.owner_id;
  return null;
end $$;
revoke all on function waldo.health_refusals_purge_on_withdrawal() from public, anon, authenticated, service_role;
create trigger health_refusals_purge_on_withdrawal after update of withdrawn_at on waldo.health_consents for each row
  when (old.withdrawn_at is null and new.withdrawn_at is not null and new.purpose = 'storage_compute')
  execute function waldo.health_refusals_purge_on_withdrawal();

-- Retention: the per-owner call and the sweep (20261011220000) also age out refusal counts older than 30 days, and the sweep
-- finds an owner whose only expired rows are counts. The result keeps its keys; the counts are not health data.
create or replace function waldo.health_retention_apply(p_owner uuid, p_auth uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_raw integer; v_requests integer; v_context integer; v_cut date := (now() at time zone 'UTC')::date - 733;
begin
  delete from waldo.health_samples where owner_id = p_owner
    and ((payload is not null and end_at < now() - interval '90 days') or (payload is null and deleted_at < now() - interval '90 days'));
  get diagnostics v_raw = row_count;
  delete from waldo.health_requests where owner_id = p_owner and created_at < now() - interval '90 days';
  get diagnostics v_requests = row_count;
  delete from public.health_context_daily where user_id = p_auth and day < v_cut;
  get diagnostics v_context = row_count;
  delete from waldo.health_context_basis where owner_id = p_owner and day < v_cut;
  delete from waldo.health_ingest_refusals where owner_id = p_owner and day < (now() at time zone 'UTC')::date - 30;
  return jsonb_build_object('raw_deleted', v_raw, 'requests_deleted', v_requests, 'context_deleted', v_context);
end $$;

create or replace function waldo.health_retention_sweep(p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_body jsonb; v_limit integer; v_owner record; v_n integer := 0; v_more boolean := false; v_one jsonb;
  v_raw integer := 0; v_requests integer := 0; v_context integer := 0;
begin
  if p_payload is null or waldo.router_signed('health.retention_sweep.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k <> 'limit')
    or jsonb_typeof(v_body->'limit') is distinct from 'number' or (v_body->>'limit') !~ '^[0-9]{1,3}$'
    or (v_body->>'limit')::integer not between 1 and 200 then return '{"error":"invalid_request"}'; end if;
  v_limit := (v_body->>'limit')::integer;
  for v_owner in
    select o.id, o.auth_user_id from waldo.owners o
    where exists (select 1 from waldo.health_samples s where s.owner_id = o.id
        and ((s.payload is not null and s.end_at < now() - interval '90 days') or (s.payload is null and s.deleted_at < now() - interval '90 days')))
      or exists (select 1 from waldo.health_requests r where r.owner_id = o.id and r.created_at < now() - interval '90 days')
      or exists (select 1 from public.health_context_daily d where d.user_id = o.auth_user_id and d.day < (now() at time zone 'UTC')::date - 733)
      or exists (select 1 from waldo.health_context_basis b where b.owner_id = o.id and b.day < (now() at time zone 'UTC')::date - 733)
      or exists (select 1 from waldo.health_ingest_refusals f where f.owner_id = o.id and f.day < (now() at time zone 'UTC')::date - 30)
    order by o.id limit v_limit + 1 for update of o skip locked
  loop
    if v_n = v_limit then v_more := true; exit; end if;
    v_one := waldo.health_retention_apply(v_owner.id, v_owner.auth_user_id);
    v_n := v_n + 1;
    v_raw := v_raw + (v_one->>'raw_deleted')::integer;
    v_requests := v_requests + (v_one->>'requests_deleted')::integer;
    v_context := v_context + (v_one->>'context_deleted')::integer;
  end loop;
  return jsonb_build_object('owners', v_n, 'more', v_more, 'raw_deleted', v_raw, 'requests_deleted', v_requests, 'context_deleted', v_context);
end $$;
