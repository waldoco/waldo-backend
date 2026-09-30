begin;
create extension if not exists pgtap with schema extensions;
select plan(14);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
insert into waldo.owners (id, do_name, email, is_admin, state) values
  ('00000000-0000-0000-0000-0000000000b1', 'projection-admin', 'admin@test.invalid', true, 'active'),
  ('00000000-0000-0000-0000-0000000000b2', 'projection-member', null, false, 'active'),
  ('00000000-0000-0000-0000-0000000000b3', 'projection-suspended', 'suspended@test.invalid', true, 'suspended');
insert into waldo.invites (code_hash, email, issued_by, expires_at, used_at, revoked_at) values
  (repeat('1',64), 'open@test.invalid', '00000000-0000-0000-0000-0000000000b1', now()+interval '1 day', null, null),
  (repeat('2',64), 'used@test.invalid', '00000000-0000-0000-0000-0000000000b1', now()+interval '1 day', now(), null),
  (repeat('3',64), 'revoked@test.invalid', '00000000-0000-0000-0000-0000000000b1', now()+interval '1 day', null, now()),
  (repeat('4',64), 'expired@test.invalid', '00000000-0000-0000-0000-0000000000b1', now()-interval '1 day', null, null),
  (repeat('5',64), 'member-issued@test.invalid', '00000000-0000-0000-0000-0000000000b2', now()+interval '1 day', null, null),
  (repeat('6',64), 'legacy@test.invalid', null, null, null, null);
create temporary table projection as select waldo.admin_overview('projection-admin', pg_temp.at(), pg_temp.sig('admin.projection-admin')) as data;
select is(waldo.admin_overview('projection-member', pg_temp.at(), pg_temp.sig('admin.projection-member')), null::jsonb, 'member receives no restricted projection');
select is(waldo.admin_overview('projection-suspended', pg_temp.at(), pg_temp.sig('admin.projection-suspended')), null::jsonb, 'suspended admin receives no restricted projection');
select throws_ok($$select waldo.admin_overview('projection-admin', pg_temp.at(), 'forged')$$, '42501', 'unsigned router call', 'signature gate remains mandatory');
select is((select data#>>'{current_issuer,id}' from projection), '00000000-0000-0000-0000-0000000000b1', 'current issuer is the signed caller canonical owner');
select is((select data#>>'{current_issuer,email}' from projection), 'admin@test.invalid', 'current issuer display email supplied independently of identity');
select is((select (data#>>'{current_issuer,issued_count}')::integer from projection), 4, 'lifetime count includes open used revoked and expired invites');
select is((select (owner->>'issued_count')::integer from projection, jsonb_array_elements(data->'owners') owner where owner->>'id'='00000000-0000-0000-0000-0000000000b2'), 1, 'other issuer count stays separate');
select is((select (owner->>'issued_count')::integer from projection, jsonb_array_elements(data->'owners') owner where owner->>'id'='00000000-0000-0000-0000-0000000000b3'), 0, 'owner without issued invites has zero count');
select is((select invite->>'issued_by' from projection, jsonb_array_elements(data->'invites') invite where invite->>'email'='open@test.invalid'), '00000000-0000-0000-0000-0000000000b1', 'attribution carries canonical issuer id');
select is((select invite->>'issuer_email' from projection, jsonb_array_elements(data->'invites') invite where invite->>'email'='open@test.invalid'), 'admin@test.invalid', 'issuer display email joins by canonical id');
select is((select invite->>'issuer_email' from projection, jsonb_array_elements(data->'invites') invite where invite->>'email'='member-issued@test.invalid'), null::text, 'known issuer without email remains email-unavailable');
select is((select invite->>'issued_by' from projection, jsonb_array_elements(data->'invites') invite where invite->>'email'='legacy@test.invalid'), null::text, 'legacy invite remains unattributed');
select is((select invite->>'issuer_email' from projection, jsonb_array_elements(data->'invites') invite where invite->>'email'='legacy@test.invalid'), null::text, 'legacy attribution does not invent an email');
select is((select count(*)::integer from projection, jsonb_array_elements(data->'invites') invite where invite ? 'code' or invite ? 'code_hash'), 0, 'projection adds no recoverable code or extra hash field');
select * from finish();
rollback;
