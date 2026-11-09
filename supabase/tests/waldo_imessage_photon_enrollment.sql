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
create function pg_temp.record(o text, phone text, uid text, num text, created boolean default true, env text default 'test') returns jsonb language sql as $$
  select waldo.imessage_enrollment_record(o, env, phone, uid, num, created, jsonb_build_array(o, env, phone, uid, num, created)::text, pg_temp.at(),
    pg_temp.isig('enroll_record', jsonb_build_array(o, env, phone, uid, num, created)::text)) $$;
create function pg_temp.enrolled(subject text, env text default 'test') returns boolean language sql as $$
  select waldo.imessage_enrolled_handle(env, subject, jsonb_build_array(env, subject)::text, pg_temp.at(), pg_temp.isig('enrolled', jsonb_build_array(env, subject)::text)) $$;

insert into waldo.owners(do_name, email, phone) values ('pe-a', 'a@test.invalid', '+15550000001'), ('pe-b', 'b@test.invalid', null);

-- Unsigned or mismatched calls never run.
select throws_ok($$ select waldo.imessage_enrollment_read('pe-a', 'test', '["pe-a","test"]', pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'a forged read is refused');
select throws_ok($$ select waldo.imessage_enrollment_read('pe-a', 'test', '["pe-b","test"]', pg_temp.at(), pg_temp.isig('enroll_read', '["pe-b","test"]')) $$,
  '42501', 'imessage locator mismatch', 'a locator for another owner is refused');

-- Read: the owner's email, phone on file, and no enrollment yet.
select is(pg_temp.read('pe-a'), '{"email":"a@test.invalid","phone":"+15550000001","phone_verified":false,"enrollment":null}'::jsonb, 'an unenrolled owner reads email and phone only');
select is(pg_temp.read('nobody'), null, 'an unknown owner reads nothing');

-- Record, then read it back.
select is(pg_temp.record('pe-a', '+15550000001', 'user-1', '+16285550101'), '{"result":"recorded","release":null}'::jsonb, 'an owner enrolls their number');
select is(pg_temp.read('pe-a')->'enrollment', '{"phone":"+15550000001","photon_user_id":"user-1","assigned_number":"+16285550101"}'::jsonb, 'the enrollment reads back');
select is(pg_temp.read('pe-a', 'other')->'enrollment', 'null'::jsonb, 'another environment sees no enrollment');
select is(pg_temp.enrolled('+15550000001'), true, 'the enrolled number is known to the bridge');
select is(pg_temp.enrolled('+15550000009'), false, 'any other number is not');

-- Enrollment proves nothing, so it locks nothing: another owner may enroll the same unlinked number (adopting the user).
select is(pg_temp.record('pe-b', '+15550000001', 'user-1', '+16285550101', false)->>'result', 'recorded', 'a second owner can enroll an unlinked number');
-- Moving off an adopted user never releases it; the first owner still references it anyway.
select is(pg_temp.record('pe-b', '+15550000002', 'user-2', '+16285550102'), '{"result":"recorded","release":null}'::jsonb, 'an adopted user is never released');

-- Possession decides: once the number is linked to pe-a, nobody else can enroll it.
insert into waldo.presences(owner_id, provider, subject) select id, 'imessage', '+15550000001' from waldo.owners where do_name = 'pe-a';
select is(pg_temp.record('pe-b', '+15550000001', 'user-1', '+16285550101', false), '{"result":"phone_taken"}'::jsonb, 'a linked number is taken');
select is((select e.phone from waldo.imessage_photon_enrollments e join waldo.owners o on o.id = e.owner_id where o.do_name = 'pe-b'), '+15550000002', 'the refusal changed nothing');

-- Release: only a Waldo-created user that nothing references and that is not the owner's linked number.
select is(pg_temp.record('pe-b', '+15550000003', 'user-3', '+16285550103')->'release', '"user-2"'::jsonb, 'moving off a Waldo-created, unreferenced user releases it');
select is(pg_temp.record('pe-a', '+15550000004', 'user-4', '+16285550104')->'release', 'null'::jsonb, 'the owner''s linked number is never released');

-- Validation.
select is(pg_temp.record('pe-b', '15550000002', 'user-2', '+16285550102')->>'result', 'rejected', 'a number without + is refused');
select is(pg_temp.record('pe-b', '+15550000002', '', '+16285550102')->>'result', 'rejected', 'an empty Photon user id is refused');
select is(pg_temp.record('pe-b', '+15550000002', 'user-2', 'call me')->>'result', 'rejected', 'a malformed assigned number is refused');

-- An inactive owner is not enrolled for the bridge and cannot record.
update waldo.owners set state = 'suspended' where do_name = 'pe-b';
select is(pg_temp.enrolled('+15550000003'), false, 'an inactive owner''s number is not enrolled');
select is(pg_temp.record('pe-b', '+15550000005', 'user-5', '+16285550105')->>'result', 'rejected', 'an inactive owner cannot enroll');

-- One row per owner per environment; owner deletion cascades.
select is(pg_temp.record('pe-a', '+15550000004', 'user-4', '+16285550104', true, 'other')->>'result', 'recorded', 'an owner enrolls separately in another environment');
select is((select count(*)::int from waldo.imessage_photon_enrollments e join waldo.owners o on o.id = e.owner_id where o.do_name = 'pe-a'), 2, 'one row per environment');
delete from waldo.owners where do_name = 'pe-a';
select is((select count(*)::int from waldo.imessage_photon_enrollments where phone = '+15550000004'), 0, 'deleting the owner deletes their enrollments');

-- Clients cannot touch the table or bypass the functions.
select ok(not has_table_privilege('anon', 'waldo.imessage_photon_enrollments', 'select'), 'anon cannot read enrollments');
select ok(not has_table_privilege('authenticated', 'waldo.imessage_photon_enrollments', 'select'), 'authenticated cannot read enrollments');

select * from finish();
rollback;
