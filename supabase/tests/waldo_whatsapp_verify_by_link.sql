begin;
create extension if not exists pgtap with schema extensions;
select plan(19);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.rsig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
-- The app's Verify with WhatsApp: the signed-in owner is issued a WhatsApp code the way the router asks for one.
create function pg_temp.issue(o text, code text) returns boolean language sql as $$
  select waldo.issue_provider_link_code(o, 'whatsapp', encode(extensions.digest(code, 'sha256'), 'hex'), pg_temp.at(),
    pg_temp.rsig('link.whatsapp.' || o || '.' || encode(extensions.digest(code, 'sha256'), 'hex'))) $$;
-- The "waldo CODE" Meta delivers from the sender's WhatsApp number, as its digits.
create function pg_temp.send(code text, sender text) returns uuid language sql as $$
  select waldo.redeem_link_code(encode(extensions.digest(code, 'sha256'), 'hex'), 'whatsapp', sender) $$;
create function pg_temp.owner(o text) returns uuid language sql as $$ select id from waldo.owners where do_name = o $$;
create function pg_temp.verified(o text) returns boolean language sql as $$
  select phone_verified_at is not null from waldo.owners where do_name = o $$;
create function pg_temp.active(o text) returns text language sql as $$
  select string_agg(subject, ',' order by subject) from waldo.presences where owner_id = pg_temp.owner(o) and provider = 'whatsapp' and state = 'active' $$;

-- An owner in onboarding: the number on file is not proven yet.
insert into waldo.owners (do_name, email, phone) values ('wa-ana', 'ana@test.invalid', '+919800000101'), ('wa-ben', 'ben@test.invalid', '+919800000102');
select ok(not pg_temp.verified('wa-ana'), 'ana''s number on file starts unverified');
select ok(pg_temp.issue('wa-ana', 'ANACODE234'), 'she is issued a WhatsApp code all the same');

-- One send from her own number proves it and links WhatsApp.
select is(pg_temp.send('ANACODE234', '919800000101'), pg_temp.owner('wa-ana'), 'her one message from that number redeems the code');
select ok(pg_temp.verified('wa-ana'), 'which verifies the number on file');
select is(pg_temp.active('wa-ana'), '919800000101', 'and links that WhatsApp number to her Waldo');
select is(pg_temp.send('ANACODE234', '919800000101'), null, 'the code works once');

-- Unlink, then relink with a fresh code from the same number: one active link again.
update waldo.presences set state = 'unlinked', unlinked_at = now() where owner_id = pg_temp.owner('wa-ana') and provider = 'whatsapp' and state = 'active';
select is(pg_temp.active('wa-ana'), null, 'after unlinking she has no WhatsApp link');
select ok(pg_temp.issue('wa-ana', 'ANACODE567'), 'she gets a new code');
select is(pg_temp.send('ANACODE567', '919800000101'), pg_temp.owner('wa-ana'), 'and relinks with one send');
select is(pg_temp.active('wa-ana'), '919800000101', 'with exactly one active link');

-- With her number verified, a code sent from another WhatsApp number moves the link there.
select ok(pg_temp.issue('wa-ana', 'ANACODE789'), 'she gets a code to link a different number');
select is(pg_temp.send('ANACODE789', '919800000188'), pg_temp.owner('wa-ana'), 'which another of her numbers redeems');
select is(pg_temp.active('wa-ana'), '919800000188', 'leaving only the new number linked');

-- A different WhatsApp number proves nothing about an unverified number on file, so it cannot link, and the code survives.
select ok(pg_temp.issue('wa-ben', 'BENCODE234'), 'ben is issued a WhatsApp code');
select throws_ok($$ select pg_temp.send('BENCODE234', '919800000199') $$, 'P0001', 'whatsapp presence requires a verified phone (phone_verified_at is null)',
  'a code sent from another number does not link while his number is unverified');
select ok(not pg_temp.verified('wa-ben'), 'and verifies nothing');
select is((select count(*)::int from waldo.link_codes where owner_id = pg_temp.owner('wa-ben') and used_at is null), 1, 'nor spends the code');
select is(pg_temp.send('BENCODE234', '919800000102'), pg_temp.owner('wa-ben'), 'which then works from his own number');
select ok(pg_temp.verified('wa-ben') and pg_temp.active('wa-ben') = '919800000102', 'verifying and linking it in that one send');

select * from finish();
rollback;
