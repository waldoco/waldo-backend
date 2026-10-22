begin;
create extension if not exists pgtap with schema extensions;
select plan(24);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.set(p_do text, p_on boolean, p_version text, p_source text) returns boolean language sql as $$
  select waldo.set_diagnostic_recording(p_do, p_on, p_version, p_source, pg_temp.at(),
    pg_temp.sig('diagnostic.set.' || p_do || '.' || case when p_on then 'on' else 'off' end || '.' || p_version || '.' || p_source)) $$;
create function pg_temp.state(p_do text) returns jsonb language sql as $$
  select waldo.diagnostic_recording_state(p_do, pg_temp.at(), pg_temp.sig('diagnostic.read.' || p_do)) $$;
insert into waldo.owners (id, do_name) values ('40000000-0000-0000-0000-00000000000a', 'do-a'), ('40000000-0000-0000-0000-00000000000b', 'do-b');
insert into waldo.owners (id, do_name, state) values ('40000000-0000-0000-0000-00000000000c', 'do-c', 'suspended');

select is(pg_temp.state('do-a'), '{"agreed": false, "version": null, "agreed_at": null}'::jsonb, 'an owner who never agreed reads as not agreed');
select is(pg_temp.state('do-unknown'), null, 'an unknown DO has no state');
select is(pg_temp.set('do-a', true, 'beta-2026-10-22', 'signup'), true, 'a signed agreement is recorded');
select is((pg_temp.state('do-a')->>'agreed')::boolean, true, 'the owner now reads as agreed');
select is(pg_temp.state('do-a')->>'version', 'beta-2026-10-22', 'with the wording version they saw');
select is(pg_temp.set('do-a', true, 'beta-2026-10-22', 'console'), true, 'agreeing again to the same wording is a no-op');
select is((select count(*)::int from waldo.diagnostic_recording_agreements where owner_id = '40000000-0000-0000-0000-00000000000a'), 1, 'and adds no second row');
select is((pg_temp.state('do-b')->>'agreed')::boolean, false, 'another owner is untouched');
select is(pg_temp.set('do-a', false, 'beta-2026-10-22', 'console'), true, 'a signed withdrawal is recorded');
select is((pg_temp.state('do-a')->>'agreed')::boolean, false, 'the owner reads as not agreed after withdrawing');
select isnt((select withdrawn_at from waldo.diagnostic_recording_agreements where owner_id = '40000000-0000-0000-0000-00000000000a'), null, 'the agreement row keeps when it was withdrawn');
select is(pg_temp.set('do-a', true, 'beta-2026-11-01', 'console'), true, 'agreeing again opens a new row');
select is((select count(*)::int from waldo.diagnostic_recording_agreements where owner_id = '40000000-0000-0000-0000-00000000000a'), 2, 'so the history of agreeing and withdrawing survives');
select is(pg_temp.set('do-a', true, 'beta-2026-11-02', 'console'), true, 'agreeing to newer wording replaces the live agreement');
select is((select count(*)::int from waldo.diagnostic_recording_agreements where owner_id = '40000000-0000-0000-0000-00000000000a' and withdrawn_at is null), 1, 'leaving one live agreement, for the newer wording');
select is(pg_temp.set('do-c', true, 'beta-2026-10-22', 'signup'), false, 'a suspended owner cannot agree');
select is(pg_temp.set('do-a', true, 'Beta 1', 'console'), false, 'a malformed wording version is refused');
select throws_ok($$ select waldo.set_diagnostic_recording('do-b', true, 'beta-2026-10-22', 'console', pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'a forged write is refused');
select throws_ok($$ select waldo.diagnostic_recording_state('do-a', pg_temp.at(), pg_temp.sig('diagnostic.read.do-b')) $$, '42501', 'unsigned router call', 'a read signed for another owner is refused');
insert into waldo.diagnostic_recording_agreements (owner_id, wording_version, source) values ('40000000-0000-0000-0000-00000000000c', 'beta-2026-10-22', 'signup');
select is(pg_temp.set('do-c', false, 'beta-2026-10-22', 'console'), true, 'a suspended owner can still withdraw');
select is((select count(*)::int from waldo.diagnostic_recording_agreements where owner_id = '40000000-0000-0000-0000-00000000000c' and withdrawn_at is null), 0, 'and the withdrawal closes their agreement');
select is(has_table_privilege('anon', 'waldo.diagnostic_recording_agreements', 'select') or has_table_privilege('authenticated', 'waldo.diagnostic_recording_agreements', 'select'), false, 'callers cannot read the table directly');
select is(has_table_privilege('anon', 'waldo.diagnostic_recording_agreements', 'insert') or has_table_privilege('authenticated', 'waldo.diagnostic_recording_agreements', 'update'), false, 'or write it directly');
delete from waldo.owners where id = '40000000-0000-0000-0000-00000000000a';
select is((select count(*)::int from waldo.diagnostic_recording_agreements where owner_id = '40000000-0000-0000-0000-00000000000a'), 0, 'deleting the owner deletes their agreement history');
select * from finish();
rollback;
