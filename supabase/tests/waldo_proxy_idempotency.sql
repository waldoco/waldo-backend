begin;
create extension if not exists pgtap with schema extensions;
select plan(25);
insert into waldo.owners (id, do_name) values ('30000000-0000-0000-0000-00000000000c', 'do-c');

insert into waldo.owners (id, do_name) values ('30000000-0000-0000-0000-00000000000d', 'do-d');
insert into waldo.connections (id, owner_id, provider, account, secret_id) values
  ('00000000-0000-0000-0000-00000000000c', '30000000-0000-0000-0000-00000000000c', 'google', 'c@test.invalid', '90000000-0000-0000-0000-00000000000c'),
  ('00000000-0000-0000-0000-00000000000d', '30000000-0000-0000-0000-00000000000d', 'google', 'd@test.invalid', '90000000-0000-0000-0000-00000000000d');

-- scope-gated access: secret + scopes in one owner-checked read
select is((select count(*) from waldo.proxy_access('do-c', '00000000-0000-0000-0000-00000000000e')), 0::bigint, 'proxy_access refuses an unknown connection');
select is((select count(*) from waldo.proxy_access('no-such-do', '00000000-0000-0000-0000-00000000000c')), 0::bigint, 'proxy_access refuses an unknown owner');

-- durable send idempotency: one claim per approved intent, replays never resend
select is((waldo.proxy_idem_claim('do-c', '00000000-0000-0000-0000-00000000000c', 'k1', 'd1'))->>'state', 'new', 'first claim of an approved send is new');
select is((waldo.proxy_idem_claim('do-c', '00000000-0000-0000-0000-00000000000c', 'k1', 'd1'))->>'state', 'pending', 'a replay of the identical signed call is pending, never a resend');
select is((waldo.proxy_idem_claim('do-c', '00000000-0000-0000-0000-00000000000c', 'k2', 'd1'))->>'state', 'new', 'two distinct approved intents with identical content are two sends, not one receipt');
select is((waldo.proxy_idem_claim('do-c', '00000000-0000-0000-0000-00000000000c', 'k1', 'd2'))->>'state', 'conflict', 'an intent id reused with different bytes conflicts, never sends');
select is(waldo.proxy_idem_store('do-c', '00000000-0000-0000-0000-00000000000c', 'k1', '{"message_id":"g1"}'::jsonb), true, 'the outcome stores against the intent');
select is((waldo.proxy_idem_claim('do-c', '00000000-0000-0000-0000-00000000000c', 'k1', 'd1'))->>'state', 'done', 'after storing, a replay resolves as done');
select is((waldo.proxy_idem_claim('do-c', '00000000-0000-0000-0000-00000000000c', 'k1', 'd1'))->'result'->>'message_id', 'g1', 'a done replay returns the stored receipt, not a second send');
select is(waldo.proxy_idem_claim('do-x', '00000000-0000-0000-0000-00000000000c', 'k1', 'd1'), null, 'an unknown owner cannot claim or read an intent');
-- Negative relationship and lifecycle cases exercise the gated public RPCs.
select is(waldo.proxy_idem_claim('do-c', '00000000-0000-0000-0000-00000000000d', 'foreign', 'd1'), null, 'foreign connection cannot claim');
select is(waldo.proxy_idem_claim('do-c', '00000000-0000-0000-0000-00000000000e', 'missing', 'd1'), null, 'nonexistent connection cannot claim');
select is(waldo.proxy_idem_store('do-d', '00000000-0000-0000-0000-00000000000c', 'k2', '{}'::jsonb), false, 'foreign owner cannot complete intent');
select is(waldo.proxy_idem_store('do-c', '00000000-0000-0000-0000-00000000000e', 'missing', '{}'::jsonb), false, 'nonexistent connection cannot complete intent');
select is(waldo.proxy_idem_store('do-c', '00000000-0000-0000-0000-00000000000c', 'k1', '{"message_id":"replacement"}'::jsonb), false, 'settled receipt cannot be overwritten');
select is((waldo.proxy_idem_claim('do-c', '00000000-0000-0000-0000-00000000000c', 'k1', 'd1'))->'result'->>'message_id', 'g1', 'original receipt remains immutable');
update waldo.connections set status = 'revoked' where id = '00000000-0000-0000-0000-00000000000c';
select is(waldo.proxy_idem_claim('do-c', '00000000-0000-0000-0000-00000000000c', 'revoked', 'd1'), null, 'revoked connection cannot claim');
select is(waldo.proxy_idem_claim('do-c', '00000000-0000-0000-0000-00000000000c', 'k1', 'd1'), null, 'revoked connection cannot replay completed data');
select is(waldo.proxy_idem_store('do-c', '00000000-0000-0000-0000-00000000000c', 'k2', '{}'::jsonb), false, 'revoked connection cannot complete pending intent');
update waldo.connections set status = 'active' where id = '00000000-0000-0000-0000-00000000000c';
update waldo.owners set state = 'suspended' where do_name = 'do-c';
select is(waldo.proxy_idem_claim('do-c', '00000000-0000-0000-0000-00000000000c', 'suspended', 'd1'), null, 'suspended owner cannot claim');
select is(waldo.proxy_idem_store('do-c', '00000000-0000-0000-0000-00000000000c', 'k2', '{}'::jsonb), false, 'suspended owner cannot complete pending intent');
update waldo.owners set state = 'active' where do_name = 'do-c';
select is(waldo.proxy_idem_claim('do-c', '00000000-0000-0000-0000-00000000000c', '', 'd1'), null, 'empty intent key refused');
select is(waldo.proxy_idem_claim('do-c', '00000000-0000-0000-0000-00000000000c', 'empty-digest', ''), null, 'empty digest refused');
set constraints waldo.proxy_idempotency_owner_connection_fk immediate;
select throws_ok($q$insert into waldo.proxy_idempotency(owner_id, connection, pkey, digest) values ('30000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000d', 'direct', 'd1')$q$, '23503', null, 'composite FK rejects foreign relationship even via direct ledger insert');
set constraints waldo.proxy_idempotency_owner_connection_fk deferred;
-- Existing delete_owner order must remain possible in one atomic transaction.
delete from waldo.connections where owner_id = '30000000-0000-0000-0000-00000000000c';
delete from waldo.owners where id = '30000000-0000-0000-0000-00000000000c';
set constraints waldo.proxy_idempotency_owner_connection_fk immediate;
select is((select count(*) from waldo.proxy_idempotency where owner_id = '30000000-0000-0000-0000-00000000000c'), 0::bigint, 'owner cascade clears ledger after connection-first atomic deletion');
select * from finish();
rollback;
