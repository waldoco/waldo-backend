begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');
insert into auth.users(id) values ('30000000-0000-0000-0000-000000000001');
insert into waldo.owners(id,do_name,auth_user_id) values
 ('10000000-0000-0000-0000-000000000001','common-owner','30000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','unbound-common-owner',null);
update waldo.owners set phone_verified_at=now() where do_name='common-owner';
insert into waldo.presences(id,owner_id,provider,subject) values
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','telegram','81101'),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','whatsapp','15550001111'),
 ('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000002','telegram','81102');
create function pg_temp.admit(provider text, subject text, name text) returns jsonb language sql as $$
 select waldo.common_owner_authority(provider,subject,name,jsonb_build_array(provider,subject,name)::text,extract(epoch from now())::bigint,
 encode(extensions.hmac(extract(epoch from now())::bigint::text || '.common.owner.' || jsonb_build_array(provider,subject,name)::text,'fixture-router','sha256'),'hex'))
$$;
select is(pg_temp.admit('telegram','81101','common-owner')->>'auth_user_id','30000000-0000-0000-0000-000000000001','signed source maps actual auth UUID');
select is(pg_temp.admit('whatsapp','15550001111','common-owner')->>'owner_id',pg_temp.admit('telegram','81101','common-owner')->>'owner_id','linked presence maps same directory owner');
select isnt(pg_temp.admit('whatsapp','15550001111','common-owner')->>'presence_id',pg_temp.admit('telegram','81101','common-owner')->>'presence_id','custody remains distinct');
select is(pg_temp.admit('telegram','81102','unbound-common-owner'),null,'unbound owner fails closed');
select is(pg_temp.admit('telegram','81101','unbound-common-owner'),null,'foreign locator cannot supply root');
select throws_ok($q$select waldo.common_owner_authority('telegram','81101','common-owner','["telegram","81101","common-owner"]',extract(epoch from now())::bigint,'forged')$q$,'42501','unsigned or mismatched common owner locator','forged signature rejected');
select throws_ok($q$select waldo.common_owner_authority('telegram','81101','common-owner','["telegram","81102","common-owner"]',extract(epoch from now())::bigint,'forged')$q$,'42501','unsigned or mismatched common owner locator','locator substitution rejected');
create temporary table receipt as select pg_temp.admit('telegram','81101','common-owner') body;
update waldo.presences set state='unlinked' where subject='15550001111';
select is(pg_temp.admit('whatsapp','15550001111','common-owner'),null,'unlinked issuer refused');
select isnt(pg_temp.admit('telegram','81101','common-owner')->>'admission_revision',(select body->>'admission_revision' from receipt),'global epoch invalidates even untouched issuer');
update waldo.presences set state='active' where subject='15550001111';
select isnt(pg_temp.admit('telegram','81101','common-owner')->>'admission_revision',(select body->>'admission_revision' from receipt),'relink cannot revive earlier custody');
update waldo.owners set state='suspended' where do_name='common-owner';
select is(pg_temp.admit('telegram','81101','common-owner'),null,'suspended owner refused');
update waldo.owners set state='active' where do_name='common-owner';
delete from auth.users where id='30000000-0000-0000-0000-000000000001';
select is(pg_temp.admit('telegram','81101','common-owner'),null,'auth deletion removes common root mapping');
select * from finish();
rollback;
