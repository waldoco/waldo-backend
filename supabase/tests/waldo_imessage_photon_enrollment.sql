begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.isig(op text, loc text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || 'imsg.' || op || '.' || encode(extensions.digest(loc, 'sha256'), 'hex'), 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.read(o text, env text default 'test') returns jsonb language sql as $$
  select waldo.imessage_enrollment_read(o, env, jsonb_build_array(o, env)::text, pg_temp.at(), pg_temp.isig('enroll_read', jsonb_build_array(o, env)::text)) $$;
create function pg_temp.record(o text, phone text, uid text, num text, env text default 'test') returns text language sql as $$
  select waldo.imessage_enrollment_record(o, env, phone, uid, num, jsonb_build_array(o, env, phone, uid, num)::text, pg_temp.at(),
    pg_temp.isig('enroll_record', jsonb_build_array(o, env, phone, uid, num)::text)) $$;
create function pg_temp.enrolled(subject text, env text default 'test') returns boolean language sql as $$
  select waldo.imessage_enrolled_handle(env, subject, jsonb_build_array(env, subject)::text, pg_temp.at(), pg_temp.isig('enrolled', jsonb_build_array(env, subject)::text)) $$;

insert into waldo.owners(do_name, email, phone) values ('pe-a', 'a@test.invalid', '+15550000001'), ('pe-b', 'b@test.invalid', null);

-- Unsigned or mismatched calls never run.
select throws_ok($$ select waldo.imessage_enrollment_read('pe-a', 'test', '["pe-a","test"]', pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'a forged read is refused');
select throws_ok($$ select waldo.imessage_enrollment_read('pe-a', 'test', '["pe-b","test"]', pg_temp.at(), pg_temp.isig('enroll_read', '["pe-b","test"]')) $$,
  '42501', 'imessage locator mismatch', 'a locator for another owner is refused');

-- Read: the owner's email, phone on file, and no enrollment yet.
select is(pg_temp.read('pe-a'), '{"email":"a@test.invalid","phone":"+15550000001","enrollment":null}'::jsonb, 'an unenrolled owner reads email and phone only');
select is(pg_temp.read('nobody'), null, 'an unknown owner reads nothing');

-- Record, then read it back; the same owner can move to another number.
select is(pg_temp.record('pe-a', '+15550000001', 'user-1', '+16285550101'), 'recorded', 'an owner enrolls their number');
select is(pg_temp.read('pe-a')->'enrollment', '{"phone":"+15550000001","photon_user_id":"user-1","assigned_number":"+16285550101"}'::jsonb, 'the enrollment reads back');
select is(pg_temp.read('pe-a', 'other')->'enrollment', 'null'::jsonb, 'another environment sees no enrollment');
select is(pg_temp.enrolled('+15550000001'), true, 'the enrolled number is known to the bridge');
select is(pg_temp.enrolled('+15550000009'), false, 'any other number is not');

-- One owner per number: another active owner cannot take it, and nothing changes.
select is(pg_temp.record('pe-b', '+15550000001', 'user-2', '+16285550102'), 'phone_taken', 'another owner cannot enroll a taken number');
select is((select count(*)::int from waldo.imessage_photon_enrollments), 1, 'the refused enrollment wrote nothing');

-- Validation.
select is(pg_temp.record('pe-b', '15550000002', 'user-2', '+16285550102'), 'rejected', 'a number without + is refused');
select is(pg_temp.record('pe-b', '+15550000002', '', '+16285550102'), 'rejected', 'an empty Photon user id is refused');
select is(pg_temp.record('pe-b', '+15550000002', 'user-2', 'call me'), 'rejected', 'a malformed assigned number is refused');

-- An inactive owner's number is free again, and the bridge stops treating it as enrolled.
update waldo.owners set state = 'suspended' where do_name = 'pe-a';
select is(pg_temp.enrolled('+15550000001'), false, 'an inactive owner''s number is not enrolled');
select is(pg_temp.record('pe-b', '+15550000001', 'user-2', '+16285550102'), 'recorded', 'another owner can take an inactive owner''s number');
select is((select o.do_name from waldo.imessage_photon_enrollments e join waldo.owners o on o.id = e.owner_id where e.phone = '+15550000001'), 'pe-b', 'the number moved');

-- Owner deletion cascades.
delete from waldo.owners where do_name = 'pe-b';
select is((select count(*)::int from waldo.imessage_photon_enrollments where phone = '+15550000001'), 0, 'deleting the owner deletes the enrollment');

-- Clients cannot touch the table or bypass the functions.
select ok(not has_table_privilege('anon', 'waldo.imessage_photon_enrollments', 'select'), 'anon cannot read enrollments');
select ok(not has_table_privilege('authenticated', 'waldo.imessage_photon_enrollments', 'select'), 'authenticated cannot read enrollments');

select * from finish();
rollback;
