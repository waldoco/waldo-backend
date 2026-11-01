begin;
create extension if not exists pgtap with schema extensions;
select plan(35);
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
create function pg_temp.phone(o text) returns text language sql as $$ select phone from waldo.owners where do_name = o $$;
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

-- A different WhatsApp number than the unproven one on file: the send proves the sending number, so it becomes his.
select ok(pg_temp.issue('wa-ben', 'BENCODE234'), 'ben is issued a WhatsApp code');
select is(pg_temp.send('BENCODE234', '919800000199'), pg_temp.owner('wa-ben'), 'a code sent from another number links');
select ok(pg_temp.verified('wa-ben') and pg_temp.phone('wa-ben') = '+919800000199', 'and that number replaces his unproven one, proven');
select is(pg_temp.active('wa-ben'), '919800000199', 'with WhatsApp linked from it');

-- Most owners have no number on file: their first WhatsApp link gives them one, proven.
insert into waldo.owners (do_name, email) values ('wa-cy', 'cy@test.invalid'), ('wa-dee', 'dee@test.invalid'), ('wa-eli', 'eli@test.invalid');
select ok(pg_temp.issue('wa-cy', 'CYCODE2345'), 'cy, with no number on file, is issued a code');
select is(pg_temp.send('CYCODE2345', '919800000301'), pg_temp.owner('wa-cy'), 'her send links');
select ok(pg_temp.verified('wa-cy') and pg_temp.phone('wa-cy') = '+919800000301', 'and makes that number hers, proven');

-- A number another owner holds is not taken: the refusal says so, nothing changes and the code survives.
select ok(pg_temp.issue('wa-dee', 'DEECODE234'), 'dee is issued a code');
select throws_ok($$ select pg_temp.send('DEECODE234', '919800000301') $$, '23505', 'presence already linked to another owner',
  'a number already linked to another owner''s WhatsApp is refused as linked elsewhere');
update waldo.presences set state = 'unlinked', unlinked_at = now() where owner_id = pg_temp.owner('wa-cy') and provider = 'whatsapp';
select throws_ok($$ select pg_temp.send('DEECODE234', '919800000301') $$, '23505', 'phone number held by another owner',
  'once unlinked, a number another owner has proven is still refused, in its own words');
select ok(not pg_temp.verified('wa-dee') and pg_temp.phone('wa-dee') is null, 'dee gains no number');
select is((select count(*)::int from waldo.link_codes where owner_id = pg_temp.owner('wa-dee') and used_at is null), 1, 'and keeps her code');

-- A sender that is not a number proves nothing and is not told the number belongs to someone else.
select throws_ok($$ select pg_temp.send('DEECODE234', 'bsuid.fixture') $$, 'P0001', 'whatsapp presence requires a verified phone (phone_verified_at is null)',
  'a subject that is not a number is refused by the presence rule, not as held elsewhere');

-- An owner who has proven a number keeps it when linking WhatsApp from another.
select ok(pg_temp.issue('wa-cy', 'CYCODE6789'), 'cy gets a new code');
select is(pg_temp.send('CYCODE6789', '919800000302'), pg_temp.owner('wa-cy'), 'and links a second WhatsApp number');
select ok(pg_temp.phone('wa-cy') = '+919800000301' and pg_temp.verified('wa-cy'), 'her proven number stays as it was');

-- iMessage from a number proves it the same way; from an Apple ID email it proves nothing.
insert into waldo.link_codes (code_hash, owner_id, provider, expires_at) values
  ('im-eli', pg_temp.owner('wa-eli'), 'imessage', now() + interval '10 minutes'),
  ('im-dee', pg_temp.owner('wa-dee'), 'imessage', now() + interval '10 minutes');
select is(waldo.redeem_link_code('im-dee', 'imessage', 'dee@icloud.test'), pg_temp.owner('wa-dee'), 'dee links iMessage from an Apple ID email');
select ok(not pg_temp.verified('wa-dee') and pg_temp.phone('wa-dee') is null, 'which gives her no number');
select is(waldo.redeem_link_code('im-eli', 'imessage', '+919800000401'), pg_temp.owner('wa-eli'), 'eli links iMessage from his number');
select ok(pg_temp.verified('wa-eli') and pg_temp.phone('wa-eli') = '+919800000401', 'which becomes his proven number');
select ok(pg_temp.issue('wa-eli', 'ELICODE234'), 'eli gets a WhatsApp code');
select is(pg_temp.send('ELICODE234', '919800000401'), pg_temp.owner('wa-eli'), 'and links WhatsApp from the same number');

select * from finish();
rollback;
