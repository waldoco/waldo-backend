begin;
create extension if not exists pgtap with schema extensions;
select plan(10);
insert into waldo.owners (id, do_name) values ('30000000-0000-0000-0000-00000000000c', 'do-c');

-- scope-gated access: secret + scopes in one owner-checked read
select is((select count(*) from waldo.proxy_access('do-c', '00000000-0000-0000-0000-00000000000c')), 0::bigint, 'proxy_access refuses an unknown connection');
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
select * from finish();
rollback;
