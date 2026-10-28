begin;
create extension if not exists pgtap with schema extensions;
select plan(52);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Today's measured Form curve and the stress word on the derived row: written through the current writer, read back by the scores
-- read for the owner's own today only, and never by the model's read or the history read. Synthetic owner and values.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.grant_body(rid text,purpose text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose',purpose,'version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.model_read(owner text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return waldo.health_context_read(owner,a,pg_temp.sig('healthctx.read.'||owner,a)); end $$;
create function pg_temp.day(offset_days int default 0) returns text language sql as $$ select to_char((now() at time zone 'UTC')::date + offset_days,'YYYY-MM-DD') $$;
create function pg_temp.ctx(extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('day',pg_temp.day(),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('score',61,'zone','good','algorithm_version','form.v9','activation','accepted','hrv_method','rmssd','confidence',0.8),
    'recovery',jsonb_build_object('score',72,'zone','good','algorithm_version','recovery.v5','activation','accepted','hrv_method','rmssd','confidence',0.8),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),'freshness','fresh') || extra $$;
create function pg_temp.write(extra jsonb default '{}') returns jsonb language sql as $$ select pg_temp.h('context_write','curve-owner',pg_temp.ctx(extra)) $$;
create function pg_temp.scores() returns jsonb language sql as $$ select pg_temp.h('scores_read','curve-owner')->'scores' $$;
create function pg_temp.refused(extra jsonb) returns boolean language sql as $$ select pg_temp.write(extra)->>'error' = 'invalid_request' $$;
-- n measured points, a quarter of an hour apart from 09:00 today in UTC, scores in range.
create function pg_temp.curve(n int default 3, kind text default 'measured') returns jsonb language sql as $$
  select jsonb_build_object('version','form.v9','points',(select jsonb_agg(jsonb_build_object(
    'at',to_char(date_trunc('day',now() at time zone 'UTC') + interval '9 hours' + k * interval '15 minutes','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'score',50 + k % 40,'kind',kind) order by k) from generate_series(0,n-1) k)) $$;
create function pg_temp.pts(points text,version text default 'form.v9') returns jsonb language sql as $$
  select jsonb_build_object('version',version,'points',points::jsonb) $$;

insert into auth.users(id,email) values ('f1000000-0000-0000-0000-0000000000f1','curve@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('f3000000-0000-0000-0000-0000000000f3','f1000000-0000-0000-0000-0000000000f1','curve-owner','curve@example.invalid');
select is(pg_temp.h('consent_grant','curve-owner',pg_temp.grant_body('grant-c-storage1','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.h('consent_grant','curve-owner',pg_temp.grant_body('grant-c-model0001','model_processing'))->'consent'->>'status','granted','and model use');

select col_type_is('public','health_context_daily','form_curve','jsonb','the derived row has a form_curve column');
select col_type_is('public','health_context_daily','stress_trend','text','and a stress_trend column');
select ok((select bool_and(is_nullable = 'YES') from information_schema.columns where table_schema='public' and table_name='health_context_daily' and column_name in ('form_curve','stress_trend')),'both nullable, so a row written without them is as it ever was');

-- Written, read back as stored by the scores read, and by nothing else.
select is(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve(),'stress_trend','rising'))->>'written','true','a row with a curve and a stress word is written');
select is(pg_temp.scores()->'form_curve',pg_temp.curve(),'the scores read returns the curve as written');
select is(pg_temp.scores()->>'stress_trend','rising','and the stress word');
select ok(not (pg_temp.model_read('curve-owner')->'context' ? 'form_curve') and not (pg_temp.model_read('curve-owner')->'context' ? 'stress_trend'),'the model''s read returns neither');
select ok(pg_temp.model_read('curve-owner')->'context' is not null and not (pg_temp.model_read('curve-owner')::text ~ 'form_curve|stress_trend|measured|rising'),'and nothing of them anywhere in its answer');
select ok(not (pg_temp.h('scores_history','curve-owner','{"days":7}')::text ~ 'form_curve|stress_trend|measured|rising'),'the history read returns neither');
select is(jsonb_array_length(pg_temp.h('scores_history','curve-owner','{"days":7}')->'history'->'days'),1,'though it returns the day itself');

-- A write for today without them clears both, so a curve does not outlive a recompute of that day that found none.
select is(pg_temp.write()->>'written','true','a row written without them lands');
select ok(not (pg_temp.scores() ? 'form_curve') and not (pg_temp.scores() ? 'stress_trend'),'and the scores read leaves both keys out, never nulls');
select ok((select form_curve is null and stress_trend is null from public.health_context_daily where user_id='f1000000-0000-0000-0000-0000000000f1'),'and the columns are cleared');
select is(pg_temp.write(jsonb_build_object('stress_trend','easing'))->>'written','true','a stress word alone is written');
select is(pg_temp.scores()->>'stress_trend','easing','and read back');
select ok(not (pg_temp.scores() ? 'form_curve'),'with no curve beside it');

-- Valid curves: one point to ninety-six, either kind, fractions of a second, the ends of the score range, projected after measured.
select is(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve(1)))->>'written','true','a curve of one point is written');
select is(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve(96)))->>'written','true','a curve of ninety-six points is written');
select is(jsonb_array_length(pg_temp.scores()->'form_curve'->'points'),96,'and all of them are read back');
select is(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve(4,'projected')))->>'written','true','a curve of projected points is written');
select is(pg_temp.write(jsonb_build_object('form_curve',pg_temp.pts('[{"at":"2026-03-20T09:00:00Z","score":0,"kind":"measured"},{"at":"2026-03-20T09:15:00.123456Z","score":100,"kind":"measured"},{"at":"2026-03-20T09:30:00Z","score":61.4285714,"kind":"projected"},{"at":"2026-03-20T09:45:00Z","score":40,"kind":"projected"}]','form.candidate.v8')))->>'written','true','measured points then projected ones, the ends of the range and fractions, under another version, are written');

-- Everything outside the shape is refused whole.
select is((select count(*)::int from unnest(array[
  'null','[]','{}','"x"','7','true',
  '{"points":[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured"}]}',
  '{"version":"form.v9"}',
  '{"version":"form.v9","points":[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured"}],"extra":1}',
  '{"version":"form.v9","points":null}','{"version":"form.v9","points":{}}','{"version":"form.v9","points":"x"}',
  '{"version":null,"points":[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured"}]}',
  '{"version":1,"points":[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured"}]}',
  '{"version":"Form.v9","points":[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured"}]}',
  '{"version":"form","points":[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured"}]}',
  '{"version":"form.v9; drop","points":[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured"}]}',
  '{"version":"form.candidate.v8.1","points":[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured"}]}',
  '{"version":"form-curve-with-a-name-far-too-long-for-any-algorithm-version-to-carry.v1","points":[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured"}]}'
]::jsonb[]) bad where pg_temp.refused(jsonb_build_object('form_curve',bad))),19,'a curve that is not an object of exactly a version name and its points is refused');
select is((select count(*)::int from unnest(array[
  '[]','[null]','["x"]','[[]]','[7]',
  '[{"score":50,"kind":"measured"}]','[{"at":"2026-03-20T09:00:00Z","kind":"measured"}]','[{"at":"2026-03-20T09:00:00Z","score":50}]',
  '[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured","note":"x"}]',
  '[{"at":"2026-03-20 09:00:00","score":50,"kind":"measured"}]','[{"at":"2026-03-20","score":50,"kind":"measured"}]','[{"at":"2026-03-20T09:00:00+05:30","score":50,"kind":"measured"}]',
  '[{"at":"2026-03-20T09:00:00","score":50,"kind":"measured"}]','[{"at":"2026-03-20T09:00Z","score":50,"kind":"measured"}]','[{"at":"2026-13-20T09:00:00Z","score":50,"kind":"measured"}]',
  '[{"at":1742461200,"score":50,"kind":"measured"}]','[{"at":null,"score":50,"kind":"measured"}]',
  '[{"at":"2026-03-20T09:00:00Z","score":-1,"kind":"measured"}]','[{"at":"2026-03-20T09:00:00Z","score":100.5,"kind":"measured"}]','[{"at":"2026-03-20T09:00:00Z","score":"50","kind":"measured"}]','[{"at":"2026-03-20T09:00:00Z","score":null,"kind":"measured"}]',
  '[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"forecast"}]','[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"Measured"}]','[{"at":"2026-03-20T09:00:00Z","score":50,"kind":null}]','[{"at":"2026-03-20T09:00:00Z","score":50,"kind":1}]'
]::jsonb[]) bad where pg_temp.refused(jsonb_build_object('form_curve',pg_temp.pts(bad::text)))),25,'points that are empty, not objects of exactly an instant, a score of 0 to 100 and a kind are refused');
select is(pg_temp.refused(jsonb_build_object('form_curve',pg_temp.curve(97))),true,'ninety-seven points are refused');
select is((select count(*)::int from unnest(array[
  '[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured"},{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured"}]',
  '[{"at":"2026-03-20T09:15:00Z","score":50,"kind":"measured"},{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured"}]',
  '[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured"},{"at":"2026-03-20T09:15:00Z","score":50,"kind":"measured"},{"at":"2026-03-20T09:14:00Z","score":50,"kind":"measured"}]',
  '[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"projected"},{"at":"2026-03-20T09:15:00Z","score":50,"kind":"measured"}]',
  '[{"at":"2026-03-20T09:00:00Z","score":50,"kind":"measured"},{"at":"2026-03-20T09:15:00Z","score":50,"kind":"projected"},{"at":"2026-03-20T09:30:00Z","score":50,"kind":"projected"},{"at":"2026-03-20T09:45:00Z","score":50,"kind":"measured"}]'
]::jsonb[]) bad where pg_temp.refused(jsonb_build_object('form_curve',pg_temp.pts(bad::text)))),5,'points not strictly increasing in time, or with a measured point after a projected one, are refused');
select is(jsonb_array_length(pg_temp.scores()->'form_curve'->'points'),4,'and a refused write leaves the row as it was');

-- The stress word: one of three, as a string.
select is((select count(*)::int from unnest(array[to_jsonb('rising'::text),to_jsonb('steady'::text),to_jsonb('easing'::text)]) good where pg_temp.write(jsonb_build_object('stress_trend',good))->>'written'='true'),3,'rising, steady and easing are written');
select is((select count(*)::int from unnest(array['"Rising"','"flat"','""','"rising "','"building"','null','1','true','["rising"]','{"w":"rising"}']::jsonb[]) bad where pg_temp.refused(jsonb_build_object('stress_trend',bad))),10,'any other value of the stress word is refused');

-- Only the owner's today: not yesterday's row, not tomorrow's, not a backfilled one.
select is(pg_temp.refused(jsonb_build_object('day',pg_temp.day(-1),'form_curve',pg_temp.curve())),true,'a curve on yesterday''s row is refused');
select is(pg_temp.refused(jsonb_build_object('day',pg_temp.day(-1),'stress_trend','steady')),true,'and a stress word on it');
select is(pg_temp.write(jsonb_build_object('day',pg_temp.day(-1)))->>'written','true','while yesterday''s row without them is written as ever');

-- A past day's measured curve is what later projections read, so a rewrite of that day without one keeps it. The fence refuses a
-- curve on that day, so it is seeded directly. The stress word is today's alone and follows the write.
update public.health_context_daily set form_curve = pg_temp.curve(2), stress_trend = 'rising'
  where user_id = 'f1000000-0000-0000-0000-0000000000f1' and day = (now() at time zone 'UTC')::date - 1;
select is(pg_temp.write(jsonb_build_object('day',pg_temp.day(-1)))->>'written','true','yesterday''s row written again without a curve lands');
select is((select form_curve from public.health_context_daily where user_id = 'f1000000-0000-0000-0000-0000000000f1' and day = (now() at time zone 'UTC')::date - 1),pg_temp.curve(2),'and keeps the curve it held');
select ok((select stress_trend is null from public.health_context_daily where user_id = 'f1000000-0000-0000-0000-0000000000f1' and day = (now() at time zone 'UTC')::date - 1),'while its stress word, which is today''s alone, is cleared');
select ok(not (pg_temp.h('scores_read','curve-owner',jsonb_build_object('day',pg_temp.day(-1)))->'scores' ? 'form_curve'),'and the scores read of that day shows no curve, since it serves today''s only');
select is(pg_temp.refused(jsonb_build_object('day',pg_temp.day(-1),'form_curve',pg_temp.curve())),true,'while a curve sent for that day is still refused');
select is(pg_temp.refused(jsonb_build_object('day',pg_temp.day(1),'form_curve',pg_temp.curve())),true,'a curve on tomorrow''s row is refused');
select is(pg_temp.write(jsonb_build_object('day',pg_temp.day(-5),'backfilled',true,'form',jsonb_build_object('reason','intraday_inputs_unavailable')))->>'written','true','a backfilled row without them is written');
select is(pg_temp.refused(jsonb_build_object('day',pg_temp.day(-5),'backfilled',true,'form',jsonb_build_object('reason','intraday_inputs_unavailable'),'form_curve',pg_temp.curve())),true,'a backfilled row with a curve is refused');
select is(pg_temp.refused(jsonb_build_object('day',pg_temp.day(-5),'backfilled',true,'form',jsonb_build_object('reason','intraday_inputs_unavailable'),'stress_trend','steady')),true,'and one with a stress word');

-- They are today's: a row of the owner's today that is still the newest after the owner's day has moved on shows neither.
select is(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve(2),'stress_trend','steady'))->>'written','true','today''s row with a curve is written again');
select ok(pg_temp.scores() ? 'form_curve' and pg_temp.scores() ? 'stress_trend','and read while it is the owner''s today');
update waldo.health_context_basis set timezone = case when extract(hour from now() at time zone 'UTC') >= 10 then 'Pacific/Kiritimati' else 'Pacific/Pago_Pago' end
  where owner_id = 'f3000000-0000-0000-0000-0000000000f3' and day = (now() at time zone 'UTC')::date;
select ok(not (pg_temp.scores() ? 'form_curve') and not (pg_temp.scores() ? 'stress_trend'),'the scores read leaves both out once the day is no longer the owner''s today');
select ok(pg_temp.scores() ? 'form' and pg_temp.scores() ? 'recovery','though the day''s scores are still there');
update waldo.health_context_basis set timezone = 'UTC' where owner_id = 'f3000000-0000-0000-0000-0000000000f3';

-- The largest row the writer takes in one call: ninety-six points with long scores and times, every pillar with its full provenance, four windows.
create function pg_temp.full_pillar(score numeric) returns jsonb language sql as $$
  select jsonb_build_object('score',score,'zone','good','algorithm_version','form.candidate.v8','activation','accepted','hrv_method','rmssd','confidence',0.8,
    'baseline',jsonb_build_object('state','personal','personal_days',30,'needed',14,'prior','adults'),
    'used',jsonb_build_object('signals',jsonb_build_array('sleep','hrv','resting_heart_rate','sleep_midpoint','daylight','movement','stress','calendar','tasks','messages','physical_load'),
      'days',(select jsonb_agg(to_char((now() at time zone 'UTC')::date - k,'YYYY-MM-DD') order by k) from generate_series(0,30) k))) $$;
create function pg_temp.worst() returns jsonb language sql as $$
  select pg_temp.ctx(jsonb_build_object('form',pg_temp.full_pillar(61.123456789),'recovery',pg_temp.full_pillar(72),'weight',pg_temp.full_pillar(55),
    'drivers',jsonb_build_array('breathing rate far above usual','wrist temperature far below usual','blood oxygen far below usual','awake time in the night far above usual','walking heart rate far above usual','breathing rate above usual','wrist temperature above usual','blood oxygen below usual'),
    'tags',jsonb_build_array('zone_changed','calendar_partial'),'sleep_debt',jsonb_build_object('state','available','debt_minutes',95.123456,'need_basis','blended_average','algorithm_version','sleep-debt.candidate.v1','activation','accepted','trend','building'),
    'read_at','2026-03-20T14:30:00.123456Z','windows_version','energy-windows.v1',
    'windows','[{"start":"09:30","end":"11:30","kind":"peak"},{"start":"14:00","end":"15:30","kind":"dip"},{"start":"16:00","end":"17:00","kind":"peak"},{"start":"19:00","end":"21:00","kind":"dip"}]'::jsonb,
    'form_curve',jsonb_build_object('version','form.candidate.v8','points',(select jsonb_agg(jsonb_build_object('at',to_char(date_trunc('day',now() at time zone 'UTC') + k * interval '15 minutes','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'score',61.123456789012345,'kind','measured') order by k) from generate_series(0,95) k)),
    'stress_trend','rising')) $$;
select ok(octet_length(pg_temp.worst()::text) between 12000 and 16384,'the worst row the producer can send is under the writer''s sixteen-kilobyte limit, and not by much (' || octet_length(pg_temp.worst()::text) || ' bytes)');
select is(pg_temp.h('context_write','curve-owner',pg_temp.worst())->>'written','true','and it is written');

-- Each owner reads only their own curve.
insert into auth.users(id,email) values ('f1000000-0000-0000-0000-0000000000f2','curve-two@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('f3000000-0000-0000-0000-0000000000f4','f1000000-0000-0000-0000-0000000000f2','curve-owner-two','curve-two@example.invalid');
select is(pg_temp.h('consent_grant','curve-owner-two',pg_temp.grant_body('grant-c2-storage','storage_compute'))->'consent'->>'status','granted','a second owner grants storage');
select is(pg_temp.h('context_write','curve-owner-two',pg_temp.ctx(jsonb_build_object('form_curve',pg_temp.curve(2),'stress_trend','easing')))->>'written','true','and writes their own curve');
select is(pg_temp.h('scores_read','curve-owner-two')->'scores'->>'stress_trend','easing','who reads it back');
select is(pg_temp.scores()->>'stress_trend','rising','while the first owner reads only their own');

select * from finish();
rollback;
