# WHOOP live test with real members (staging, 1 to 2 days)

What this proves: a real WHOOP member connects on staging, a month backfills, tokens refresh, a workout and a night arrive by
webhook and reach the workout wake and the morning Brief, edits and deletes in the WHOOP app follow through, Apple Health's copy
of WHOOP's data is not counted twice, disconnect and reconnect work, withdrawing storage purges everything, and the pass stays
inside WHOOP's rate limits. It covers health revision 16 (`docs/app/WHOOP_AND_OURA_2026-10-21.md`, "What Waldo reads from WHOOP").

Rules for the test:

- Staging only. Each member has given both WHOOP grants in the app. WHOOP data is never used to build, test, train, tune or
  evaluate any model, prompt or eval: nothing from these accounts is copied into a fixture, eval case, trace export or issue.
- The SQL below returns kinds, counts, days, revisions and whether a key is present, never a member's reading. Do not select
  `payload->'value'` or any other value for a real member. Staging trace capture is opted in by the testers (owner ruling of
  10 October 2026); production captures no text.
- Log lines are JSON in the Worker's logs (`wrangler tail` on the staging Worker, or the dashboard's log search). Match on the
  fields given; the full line also carries a `trace` and `ms`.
- In psql, set the member once: `\set owner 'the member''s do_name'` (find it with
  `select do_name from waldo.owners where email = :'email';`).

Shared queries, used below:

```sql
-- Q1 kinds stored for WHOOP: count, newest day and newest revision per kind.
select s.signal, count(*) as n, max(s.day) as newest_day, to_timestamp(max(s.revision)) as newest_revision
from waldo.health_samples s join waldo.owners o on o.id = s.owner_id
where o.do_name = :'owner' and s.source = 'whoop' and s.payload is not null
group by s.signal order by s.signal;

-- Q2 the member's WHOOP grants and the copy each rests on.
select c.purpose, c.version, c.granted_at, c.withdrawn_at
from waldo.health_consents c join waldo.owners o on o.id = c.owner_id
where o.do_name = :'owner' and c.source = 'whoop' order by c.granted_at;

-- Q3 the connection the edge holds (never the secret).
select c.id, c.status, c.scopes, c.last_refresh_at, c.last_used_at, c.last_error
from waldo.connections c join waldo.owners o on o.id = c.owner_id
where o.do_name = :'owner' and c.provider = 'whoop' order by c.created_at desc;

-- Q4 what one kind's rows carry, by key presence only.
select s.day, s.sample_id, to_timestamp(s.revision) as revision, (select array_agg(k order by k) from jsonb_object_keys(s.payload) k) as keys
from waldo.health_samples s join waldo.owners o on o.id = s.owner_id
where o.do_name = :'owner' and s.source = 'whoop' and s.signal = :'kind' and s.payload is not null
order by s.day desc limit 10;
```

## Before hour 0

| Check | How | Pass |
|---|---|---|
| Migration applied | `select 1 from supabase_migrations.schema_migrations where version = '20261127120000';` | one row |
| Deploy carries health revision 16 | the Worker deployed from this branch's merge; `select pg_get_functiondef('waldo.health_ingest(text,text,bigint,text)'::regprocedure) like '%provider_recovery%';` | `t` |
| WHOOP app scopes | WHOOP developer dashboard: the app has all six scopes (`offline read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout`), the redirect and v2 webhook URLs point at staging | as listed |
| Worker secrets | `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `WHOOP_REDIRECT_URI` set on staging; edge client seeded (`docs/ops/PRE_REGISTERED_OAUTH_CLIENTS.md`) | routes answer, not `not_configured` |
| Model-provider terms | item 3 of "WHOOP consent copy": zero retention and no training with every provider an owner turn can route to | in place, or the test does not start |
| Member's grants | Q2 | `storage_compute` and `model_processing`, `withdrawn_at` null; version 6 for WHOOP's scores to be stored (version 4 stores readings only) |

## Hour 0: connect and backfill

1. The member opens Waldo, Connections, WHOOP, Connect, Continue, signs in at WHOOP and approves all six scopes.
2. Logs, in order: `{"hop":"whoop_edge","ok":true,"code":"started"}`, then `{"hop":"whoop","ok":true,"code":"linked"}`, then
   `{"hop":"whoop_edge","ok":true,"code":"linked"}`. The page reads "WHOOP is connected".
3. Within a few minutes the first pass: `{"hop":"whoop","ok":true,"code":"synced"}` and
   `{"hop":"whoop","ok":true,"code":"rate_remaining_high"}`.
4. Q3: one row, `status = 'active'`, `scopes` holds all six.
5. Q1: about 30 days of `sleep_duration`, `sleep_midpoint`, `sleep_efficiency`, `overnight_hrv`, `resting_heart_rate`,
   `respiratory_rate`, `provider_recovery`, `provider_sleep_need`, `provider_sleep_performance`, `provider_sleep_consistency`,
   `provider_day_strain`, `workout` (if the member trained), `nap` (if they napped), `spo2` and `skin_temperature` (4.0 and later
   straps only), and one each of `body_mass`, `height`, `max_heart_rate`.
6. Q4 with `\set kind 'sleep_duration'`: `keys` includes `stage_totals`. With `'provider_recovery'`: includes `calibrating`.
   With `'provider_day_strain'`: the newest row includes `open` (and `step_count` where WHOOP counted steps).
7. App: the provider status shows WHOOP connected and no reconnect prompt (`reconnect_for` absent).
8. Fails if: any `{"hop":"whoop","ok":false,...}` line other than `rate_remaining_low`; `code` of `sample_dropped` or
   `record_dropped` (a WHOOP answer Waldo could not read: note the time, do not copy the record); Q1 empty.

## Hour 0 to 1: token refresh

WHOOP access tokens last about an hour, and the edge refreshes one about two minutes before it lapses.

1. Have the member ask Waldo something that reads health about 70 minutes after connecting, or wait for any webhook after that.
2. Q3: `last_refresh_at` is within the last hour and after the connect time; `status` still `active`.
3. Logs: no `{"hop":"whoop","ok":false,"code":"needs_reconnect"}`.
4. Fails if: `status = 'failing'` or the provider status reads `needs_reconnect` while the member did not revoke access at WHOOP.

## Hours 1 to 6: a workout

1. The member logs or records a workout in WHOOP (at least 15 minutes, strap on).
2. When WHOOP finishes scoring it (minutes after it ends), logs: `{"hop":"whoop_edge","ok":true,"code":"hint_routed"}`, then
   `{"hop":"whoop","ok":true,"code":"hint_handled"}`.
3. Q4 with `\set kind 'workout'`: a new row for today whose `keys` include `hr_zones`, `strain` (copy 6 only), `avg_hr_bpm`,
   `max_hr_bpm`, `energy_kcal`, `percent_recorded`, and `distance_m` or `elevation_gain_m` where WHOOP had them.
4. Q4 with `\set kind 'provider_day_strain'`: today's row has a `revision` after the workout ended (the webhook re-read the cycle).
5. With `WORKOUT_WAKE=1` on staging: the health trigger runs once for the workout and the member may get one look at the rest of
   the day, or nothing. Ask the member in Waldo "how hard was that workout?": the reply uses WHOOP's strain and zone minutes and
   calls the strain WHOOP's.
6. Fails if: `hint_failed`, `hint_rate_limited` repeated, or the workout row is missing after the next daily pass.
7. `cycles_deferred` alone is not a failure: the cycle read after the webhook failed and the next pass catches it up.

## Night 1 into morning: sleep, recovery, Brief

1. The member sleeps with the strap on. On waking, WHOOP sends `sleep.updated` and then `recovery.updated` (the recovery's id is
   the sleep's). Logs: two `hint_handled` lines minutes apart.
2. Q1: `sleep_duration`, `provider_recovery`, `provider_sleep_need`, `provider_sleep_performance` have today as `newest_day`.
3. Q4 with `\set kind 'provider_day_strain'`: yesterday's row no longer has `open` true once WHOOP closed the cycle; today's is
   open.
4. Waldo's own row for today exists and names WHOOP as its basis when WHOOP holds the night (sources only, no score):
   `select b.day, b.consent_basis from waldo.health_context_basis b join waldo.owners o on o.id = b.owner_id where o.do_name = :'owner' order by b.day desc limit 2;`
5. With `WAKE_BRIEF=1`: the morning Brief arrives after the night ends. It speaks to WHOOP's recovery against the member's usual,
   whether last night met the need WHOOP set (and whether that need counts sleep debt), and keeps WHOOP's numbers labelled as
   WHOOP's, never as Waldo's Recovery. Ask the member to screenshot the Brief for the test record (the member's own copy).
6. Fails if: the Brief calls WHOOP's recovery "your Recovery score", invents a value WHOOP did not send, or says nothing about
   recovery or sleep need while Q1 shows them fresh.

## Day 2 morning: edits and deletes in the WHOOP app

1. The member edits last night's sleep times in WHOOP. Logs: `hint_handled`. Q4 with `\set kind 'sleep_duration'`: today's row
   has a newer `revision`.
2. The member deletes the workout from hour 1. Logs: `hint_handled`. Then:
   ```sql
   select s.signal, s.sample_id, s.deleted_at, s.payload is null as tombstone
   from waldo.health_samples s join waldo.owners o on o.id = s.owner_id
   where o.do_name = :'owner' and s.source = 'whoop' and s.sample_id like 'whoop:%:workout' and s.deleted_at is not null;
   ```
   one tombstone for that workout.
3. If the member deletes a nap or a sleep, every kind it made is tombstoned (`sleep_duration`, `sleep_midpoint`,
   `sleep_efficiency`, `respiratory_rate`, the three `provider_sleep_*`, `nap`, and the recovery's `overnight_hrv`,
   `resting_heart_rate`, `spo2`, `provider_recovery`, `skin_temperature`).
4. Fails if: an older backfill page brings the deleted record back (a later pass shows a non-null payload for that `sample_id`).

## Day 2: Apple Health duplicate check (iPhone members who also share Apple Health)

1. In the WHOOP iOS app, Apple Health integration on (WHOOP writes sleep, workouts and some vitals there). The member's Waldo app
   uploads Apple Health as usual.
2. Which bundle WHOOP's app writes as (confirm the prefix the read marks; expect `com.whoop.*`):
   ```sql
   select s.payload #>> '{origin,source_bundle_id}' as bundle, s.signal, count(*)
   from waldo.health_samples s join waldo.owners o on o.id = s.owner_id
   where o.do_name = :'owner' and s.source = 'apple' and s.payload #>> '{origin,source_bundle_id}' ilike '%whoop%'
   group by 1, 2 order by 1, 2;
   ```
   If the bundle does not start with `com.whoop`, stop and report it: the dedupe would not recognise it.
3. Today's Waldo row (step 4 of Night 1) names `whoop`, not `apple`, in `consent_basis` on a night only the WHOOP strap measured,
   though Apple ranks above WHOOP: the producer dropped Apple's copy of WHOOP's night.
4. Ask Waldo "how did I sleep last night?": one night, WHOOP's, not two.
5. Fails if: the row's basis is `apple` on a night the only device on the wrist was WHOOP, or Waldo reports two nights or doubled
   workout minutes.

## Day 2: disconnect and reconnect

1. App: Connections, WHOOP, Disconnect. Logs: `{"hop":"whoop","ok":true,"code":"disconnected"}`. Q3: `status = 'revoked'`.
   The member's WHOOP app shows Waldo removed (WHOOP answers `DELETE /v2/user/access` with 204).
2. Q1 still shows the stored rows: disconnecting keeps what was stored until storage is withdrawn.
3. Connect again (Hour 0 steps 1 to 3). Logs: `linked`, then a pass `synced`. Q1: newest rows refresh; no duplicates (Q1 counts
   do not double).
4. Old-scope check, only with a member who connected before this release: before reconnecting, the provider status names
   `reconnect_for: ["day_strain","body_measurements"]` (app on health revision 16), their sleep, recovery and workouts kept
   syncing, and logs show no `needs_reconnect`. After reconnecting, `reconnect_for` is gone and `provider_day_strain` rows appear.

## Day 2: storage-consent withdrawal purge

Do this last, with a member who agrees to lose their stored WHOOP data.

1. App: withdraw the WHOOP storage consent.
2. Q2: `storage_compute` has `withdrawn_at` set (and `model_processing` with it).
3. Purge:
   ```sql
   select count(*) from waldo.health_samples s join waldo.owners o on o.id = s.owner_id
   where o.do_name = :'owner' and s.source = 'whoop' and s.payload is not null;
   ```
   `0`.
4. The next pass logs `{"hop":"whoop","ok":false,"code":"consent_required"}` and stores nothing; the provider status reads
   `consent_required`.
5. Fails if: any WHOOP row keeps a payload, or a later webhook stores one.

## Throughout: rate limits

- Every pass logs one `rate_remaining_high`, `rate_remaining_mid` or `rate_remaining_low`, from WHOOP's `X-RateLimit-Remaining`
  header: the fewest requests left in WHOOP's window since the last pass. Expect `high` with a handful of members.
- `rate_remaining_low`, `{"hop":"whoop","ok":false,"code":"rate_limited"}` or `hint_rate_limited` with fewer than 20 members is a
  finding: note when and how many members connected in that hour. A rate-limited pass waits for WHOOP's reset and resumes from
  the last committed window.
- Budget: a 30-day backfill is about 25 requests, a daily pass about 5, a webhook 1 to 3. WHOOP allows 100 a minute and 10,000 a
  day per client.

## Record

For each member: connect time, Q1 kinds present, each step's pass or fail, and the time of any failure. No readings, screenshots
of readings, or record ids in the shared record; the member keeps their own screenshots.
