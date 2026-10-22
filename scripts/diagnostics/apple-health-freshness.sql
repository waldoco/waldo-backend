-- READ-ONLY DIAGNOSTIC. It changes nothing: everything runs inside a read-only transaction that is rolled back.
--
-- Why is the owner's newest Apple Health reading old? This prints, for one owner, only counts, timestamps, dates, source and
-- signal names, consent versions and closed reason codes. It never prints a reading's value, a payload, an anchor, a sample
-- or request id, the owner's id or email.
--
-- Run on the Mac against staging with a role that can read the health plane (its tables force row-level security, so use
-- the database owner connection from the Supabase dashboard; section 0 says whether the role can see every row):
--
--   psql "$STAGING_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v owner_email='<the owner sign-in email>' \
--     -f scripts/diagnostics/apple-health-freshness.sql
--
-- STAGING_DATABASE_URL is read from your shell; never paste it into a file or a chat. How to read the output is in
-- docs/app/APPLE_HEALTH_FRESHNESS_2026-10-22.md.
\set QUIET on
\pset footer off
begin transaction isolation level repeatable read read only;

\echo '== 0. Server clock and whether this role sees every row'
select now() as server_now, current_user as role, (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as sees_every_row;

\echo '== 1. Health migrations applied (per-sample ingest is 20261022150000)'
select version, name from supabase_migrations.schema_migrations
where version >= '20261011000000' and (name like '%health%' or version = '20261022150000') order by version;

-- One row always, so an unknown email reads 'not found' instead of stopping the script.
with found as (select o.id, o.auth_user_id, o.state from waldo.owners o where lower(o.email) = lower(:'owner_email') order by (o.state = 'active') desc limit 1)
select coalesce((select id from found), '00000000-0000-0000-0000-000000000000') as diag_owner,
  coalesce((select auth_user_id from found), '00000000-0000-0000-0000-000000000000') as diag_auth,
  coalesce((select state from found), 'not found') as diag_state \gset
\echo '== 2. Owner row (state only; ingest needs active)'
select :'diag_state' as owner_state;

\echo '== 3. Health consent per source and purpose (an upload needs a live storage_compute grant at the epoch it names)'
select s.source, s.purpose, s.epoch as scope_epoch, c.version as copy_version, c.granted_at, c.withdrawn_at
from waldo.health_scopes s left join waldo.health_consents c on c.id = s.consent_id
where s.owner_id = :'diag_owner' order by s.source, s.purpose;

\echo '== 4. Stored anchor per source (present or not; its content is never printed)'
select source, epoch, char_length(anchor) > 0 as anchor_present from waldo.health_anchors where owner_id = :'diag_owner' order by source;

\echo '== 5. Accepted uploads per UTC day, last 21 days (a refused upload stores no row: a gap here with the app running means refusals)'
select (created_at at time zone 'UTC')::date as utc_day, response->>'source' as source, count(*) as uploads,
  sum((response->>'accepted')::int) as accepted, sum((response->>'ignored')::int) as ignored, sum((response->>'deleted')::int) as deleted,
  count(*) filter (where response ? 'rejected') as per_sample_uploads, sum(jsonb_array_length(coalesce(response->'rejected', '[]'))) as rejected_changes
from waldo.health_requests where owner_id = :'diag_owner' and operation = 'ingest' and created_at > now() - interval '21 days'
group by 1, 2 order by 1 desc, 2;

\echo '== 6. Newest accepted upload per source'
select response->>'source' as source, max(created_at) as newest_upload, count(*) as uploads_kept
from waldo.health_requests where owner_id = :'diag_owner' and operation = 'ingest' group by 1 order by 1;

\echo '== 7. Per-sample rejections by reason, kind and signal (only builds that send health=3 get these)'
select r->>'change' as change, coalesce(r->>'signal', '(unknown)') as signal, r->>'reason' as reason, count(*) as changes, max(q.created_at) as newest
from waldo.health_requests q cross join lateral jsonb_array_elements(coalesce(q.response->'rejected', '[]')) r
where q.owner_id = :'diag_owner' and q.operation = 'ingest' group by 1, 2, 3 order by changes desc;

\echo '== 8. Stored readings per source and signal: newest end and local day (raw retention is 90 days)'
select source, signal, count(*) filter (where payload is not null) as live, count(*) filter (where payload is null) as tombstones,
  max(end_at) as newest_end, max(day) as newest_day, min(day) as oldest_day
from waldo.health_samples where owner_id = :'diag_owner' group by 1, 2 order by 1, 2;

\echo '== 9. Stored readings per local day, last 21 days'
select day, source, count(*) as readings, count(distinct signal) as signals
from waldo.health_samples where owner_id = :'diag_owner' and payload is not null and day > current_date - 21
group by 1, 2 order by 1 desc, 2;

\echo '== 10. Derived daily rows, newest 14 (what Waldo and /scores read; written from stored readings after each upload)'
select c.day, c.created_at, c.updated_at, c.freshness as freshness_at_write, b.timezone as basis_timezone, b.day is not null as has_basis
from public.health_context_daily c left join waldo.health_context_basis b on b.owner_id = :'diag_owner' and b.day = c.day
where c.user_id = :'diag_auth' order by c.day desc limit 14;

rollback;
