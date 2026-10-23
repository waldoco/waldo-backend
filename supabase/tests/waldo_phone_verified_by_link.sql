begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.rsig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.h(c text) returns text language sql as $$ select repeat(c, 64) $$;
create function pg_temp.plink(o text, prov text, code text) returns boolean language sql as $$
  select waldo.issue_provider_link_code(o, prov, code, pg_temp.at(), pg_temp.rsig('link.' || prov || '.' || o || '.' || code)) $$;
create function pg_temp.redeem_link(code text, prov text, subj text) returns uuid language sql as $$
  select waldo.redeem_link(code, prov, subj, pg_temp.at(), pg_temp.rsig('redeem.' || code || '.' || prov || '.' || subj)) $$;
create function pg_temp.verified(o text) returns boolean language sql as $$
  select phone_verified_at is not null from waldo.owners where do_name = o $$;
create function pg_temp.live(prov text, subj text) returns text language sql as $$
  select o.do_name from waldo.presences p join waldo.owners o on o.id = p.owner_id where p.provider = prov and p.subject = subj and p.state = 'active' $$;
create function pg_temp.unspent(code text) returns boolean language sql as $$
  select used_at is null from waldo.link_codes where code_hash = code $$;

-- The number each owner typed at sign-up is unverified contact data until a link code arrives from it.
insert into waldo.owners (do_name, email, phone) values
  ('do-vera', 'vera@test.invalid', '+15550001111'),
  ('do-wes', 'wes@test.invalid', '+15550002222'),
  ('do-ned', 'ned@test.invalid', '+15550003333'),
  ('do-twin', 'twin@test.invalid', '+15550001111'),
  ('do-tom', 'tom@test.invalid', '+15550004444');

-- iMessage: the code arriving from the number on file links the handle and proves the number in one step.
select is(pg_temp.plink('do-vera', 'imessage', pg_temp.h('1')), true, 'vera gets an iMessage link code');
select isnt(pg_temp.redeem_link(pg_temp.h('1'), 'imessage', '+15550001111'), null, 'the code sent from the number on file links');
select is(pg_temp.live('imessage', '+15550001111'), 'do-vera', 'the handle is live for vera');
select ok(pg_temp.verified('do-vera'), 'and her number is verified');

-- A code sent from anything else still links that handle, as before, but proves nothing about the number on file.
select is(pg_temp.plink('do-wes', 'imessage', pg_temp.h('2')), true, 'wes gets an iMessage link code');
select isnt(pg_temp.redeem_link(pg_temp.h('2'), 'imessage', 'wes@icloud.test'), null, 'a code sent from an Apple ID email links that handle');
select ok(not pg_temp.verified('do-wes'), 'but verifies no number');
select is(pg_temp.plink('do-wes', 'imessage', pg_temp.h('3')), true, 'wes gets another iMessage link code');
select isnt(pg_temp.redeem_link(pg_temp.h('3'), 'imessage', '+15550009999'), null, 'a code sent from another number links that number');
select ok(not pg_temp.verified('do-wes'), 'but does not verify the number on file');

-- WhatsApp: the subject is the number's digits. The code from the number on file verifies it before the presence is
-- written, so the presence rule that wants a verified number admits it.
select is(pg_temp.plink('do-wes', 'whatsapp', pg_temp.h('4')), true, 'wes gets a WhatsApp link code');
select isnt(pg_temp.redeem_link(pg_temp.h('4'), 'whatsapp', '15550002222'), null, 'a WhatsApp code from the number on file links');
select is(pg_temp.live('whatsapp', '15550002222'), 'do-wes', 'the WhatsApp presence is live for wes');
select ok(pg_temp.verified('do-wes'), 'and his number is verified');

-- A WhatsApp code from another number still needs a verified number: nothing links, nothing is verified, the code stays.
select is(pg_temp.plink('do-ned', 'whatsapp', pg_temp.h('5')), true, 'ned gets a WhatsApp link code');
select throws_ok($$ select pg_temp.redeem_link(pg_temp.h('5'), 'whatsapp', '15550008888') $$, null, 'whatsapp presence requires a verified phone (phone_verified_at is null)',
  'a WhatsApp code from a number ned does not have on file is refused');
select ok(not pg_temp.verified('do-ned'), 'ned stays unverified');
select is(pg_temp.live('whatsapp', '15550008888'), null, 'and that number is not linked');
select ok(pg_temp.unspent(pg_temp.h('5')), 'the code is not spent');

-- A number already verified for another active owner is not verified again for a second account that typed it.
select is(pg_temp.plink('do-twin', 'whatsapp', pg_temp.h('6')), true, 'the second account with vera''s number gets a WhatsApp code');
select throws_ok($$ select pg_temp.redeem_link(pg_temp.h('6'), 'whatsapp', '15550001111') $$, null, 'whatsapp presence requires a verified phone (phone_verified_at is null)',
  'a code from a number another owner already verified does not verify it here');
select ok(not pg_temp.verified('do-twin'), 'the second account stays unverified');
select ok(pg_temp.unspent(pg_temp.h('6')), 'and its code is not spent');

-- A handle live under another owner rolls the whole redemption back: no presence, no verification, the code unspent.
select is(pg_temp.plink('do-twin', 'imessage', pg_temp.h('7')), true, 'the second account gets an iMessage code');
select throws_ok($$ select pg_temp.redeem_link(pg_temp.h('7'), 'imessage', '+15550001111') $$, '23505', 'presence already linked to another owner',
  'a handle live under vera cannot be linked by the second account');
select ok(not pg_temp.verified('do-twin'), 'which stays unverified');
select ok(pg_temp.unspent(pg_temp.h('7')), 'with its code unspent');

-- Single use and short-lived: a spent or expired code verifies nothing.
update waldo.presences set state = 'unlinked', unlinked_at = now() where provider = 'imessage' and subject = '+15550001111';
update waldo.owners set phone_verified_at = null where do_name = 'do-vera';
select is(pg_temp.redeem_link(pg_temp.h('1'), 'imessage', '+15550001111'), null, 'a spent code does not redeem again');
select ok(not pg_temp.verified('do-vera'), 'and verifies nothing');
select is(pg_temp.plink('do-vera', 'imessage', pg_temp.h('8')), true, 'vera gets a fresh code');
update waldo.link_codes set expires_at = now() - interval '1 second' where code_hash = pg_temp.h('8');
select is(pg_temp.redeem_link(pg_temp.h('8'), 'imessage', '+15550001111'), null, 'an expired code does not redeem');
select ok(not pg_temp.verified('do-vera'), 'and verifies nothing');

-- Telegram subjects are chat ids, never a phone number.
select is(pg_temp.plink('do-tom', 'telegram', pg_temp.h('9')), true, 'tom gets a Telegram link code');
select isnt(pg_temp.redeem_link(pg_temp.h('9'), 'telegram', '15550004444'), null, 'a Telegram code links the chat');
select ok(not pg_temp.verified('do-tom'), 'and verifies no number, even when the chat id reads like it');

-- A verification belongs to the number it proved: a new number on file starts unverified.
select ok(pg_temp.verified('do-wes'), 'wes is verified');
update waldo.owners set phone = '+15550005555' where do_name = 'do-wes';
select ok(not pg_temp.verified('do-wes'), 'changing the number on file clears the verification');
update waldo.owners set phone_verified_at = now() where do_name = 'do-ned';
update waldo.owners set email = 'ned2@test.invalid' where do_name = 'do-ned';
select ok(pg_temp.verified('do-ned'), 'a change that leaves the number alone keeps the verification');

select * from finish();
rollback;
