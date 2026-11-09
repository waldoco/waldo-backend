begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('agent-mail-rules-fixture-router', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'agent-mail-rules-fixture-router', 'sha256'), 'hex')
$$;
insert into auth.users(id, email, email_confirmed_at) values
  ('76000000-0000-0000-0000-000000000001', 'rules-a@test.invalid', now()),
  ('76000000-0000-0000-0000-000000000002', 'rules-b@test.invalid', now()),
  ('76000000-0000-0000-0000-000000000003', 'rules-c@test.invalid', now());
insert into waldo.owners(id, auth_user_id, do_name, email) values
  ('77000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-000000000001', 'rules-owner-a', 'rules-a@test.invalid'),
  ('77000000-0000-0000-0000-000000000002', '76000000-0000-0000-0000-000000000002', 'rules-owner-b', 'rules-b@test.invalid'),
  ('77000000-0000-0000-0000-000000000003', '76000000-0000-0000-0000-000000000003', 'rules-owner-c', 'rules-c@test.invalid');
create function pg_temp.claim(do_name text, handle text, notice text default '2026-10-31') returns text language sql as $$
  select waldo.claim_agent_mail_handle(do_name, handle, notice, pg_temp.at(), pg_temp.sig(waldo.agent_mail_signed('mailclaim', do_name, handle, notice)))
$$;
create function pg_temp.release(do_name text) returns text language sql as $$
  select waldo.release_agent_mail_handle(do_name, pg_temp.at(), pg_temp.sig(waldo.agent_mail_signed('mailrelease', do_name)))
$$;
create function pg_temp.current(do_name text) returns table (handle text, rule_state text) language sql as $$
  select * from waldo.agent_mail_handle(do_name, pg_temp.at(), pg_temp.sig(waldo.agent_mail_signed('mailhandle', do_name)))
$$;
create function pg_temp.settle(do_name text, handle text, state text) returns boolean language sql as $$
  select waldo.settle_agent_mail_rule(do_name, handle, state, pg_temp.at(), pg_temp.sig(waldo.agent_mail_signed('mailsettle', do_name, handle, state)))
$$;
create function pg_temp.held(handles text) returns setof text language sql as $$
  select * from waldo.agent_mail_held_handles(handles, pg_temp.at(), pg_temp.sig(waldo.agent_mail_signed('mailheld', handles)))
$$;

select is(pg_temp.claim('rules-owner-a', 'priya'), 'claimed', 'an owner claims a free handle');
select results_eq($$select * from pg_temp.current('rules-owner-a')$$, $$values ('priya'::text, 'pending'::text)$$, 'its rule starts pending');
select results_eq($$select notice_version, notice_accepted_at is not null from waldo.agent_mail_handles where handle = 'priya'$$,
  $$values ('2026-10-31'::text, true)$$, 'the claim records the notice the owner accepted, and when');
select is(pg_temp.claim('rules-owner-a', 'priya', '2026-11-05'), 'unchanged', 'claiming the same handle again changes nothing');
select results_eq($$select notice_version from waldo.agent_mail_handles where handle = 'priya'$$, $$values ('2026-11-05'::text)$$, 'but records the newer notice accepted');
select throws_ok($$select pg_temp.claim('rules-owner-c', 'free', 'v 1')$$, '22023', 'notice version', 'a claim names a notice version');
select throws_ok(format($$select waldo.claim_agent_mail_handle('rules-owner-c', 'free', '2026-10-31', %s, %L)$$, pg_temp.at(), pg_temp.sig(waldo.agent_mail_signed('mailclaim', 'rules-owner-c', 'free', '2026-11-05'))),
  '42501', 'unsigned router call', 'a claim signed for another notice version is refused');
select throws_ok($$insert into waldo.agent_mail_handles (handle, owner_id, notice_version) values ('half', '77000000-0000-0000-0000-000000000003', '2026-10-31')$$,
  '23514', null, 'a notice version is kept only with its time');
select is(pg_temp.claim('rules-owner-b', 'priya'), 'taken', 'a held handle is taken');
select is(pg_temp.claim('rules-owner-b', 'postmaster'), 'unavailable', 'a reserved handle is unavailable');
select is(pg_temp.claim('rules-owner-b', 'A..b'), 'unavailable', 'a malformed handle is unavailable');
select is(pg_temp.claim('nobody', 'free'), 'no_owner', 'an unknown owner object claims nothing');
update waldo.owners set state = 'suspended' where do_name = 'rules-owner-c';
select is(pg_temp.claim('rules-owner-c', 'free'), 'no_owner', 'a suspended owner claims nothing');
update waldo.owners set state = 'active' where do_name = 'rules-owner-c';

select ok(pg_temp.settle('rules-owner-a', 'priya', 'live'), 'the owner object reports the rule live');
select ok(not pg_temp.settle('rules-owner-a', 'priya', 'failed'), 'only a pending rule moves');
select ok(not pg_temp.settle('rules-owner-b', 'priya', 'live'), 'another owner cannot settle it');
select throws_ok($$select pg_temp.settle('rules-owner-a', 'priya', 'pending')$$, '22023', 'rule state', 'a settle names an outcome');
update waldo.agent_mail_handles set rule_state = 'failed' where handle = 'priya';
select is(pg_temp.claim('rules-owner-a', 'priya'), 'claimed', 'claiming a failed handle again retries its rule');
select results_eq($$select rule_state from pg_temp.current('rules-owner-a')$$, $$values ('pending'::text)$$, 'back to pending');

-- A rename releases the old handle in the same transaction; a refused rename keeps it.
select is(pg_temp.claim('rules-owner-b', 'bee'), 'claimed', 'a second owner claims');
select is(pg_temp.claim('rules-owner-b', 'priya'), 'taken', 'a rename to a held handle is refused');
select results_eq($$select handle from pg_temp.current('rules-owner-b')$$, $$values ('bee'::text)$$, 'and keeps the old handle');
select is(pg_temp.claim('rules-owner-b', 'bee.two'), 'claimed', 'a rename succeeds');
select results_eq($$select handle from pg_temp.current('rules-owner-b')$$, $$values ('bee.two'::text)$$, 'the owner holds the new handle');
select is(pg_temp.claim('rules-owner-c', 'bee'), 'unavailable', 'the renamed-away handle is released for 180 days');
select ok(not pg_temp.settle('rules-owner-b', 'bee', 'live'), 'a settle for the old handle answers false');

select results_eq($$select * from pg_temp.held('priya,bee,bee.two,nobody') order by 1$$, $$values ('bee.two'::text), ('priya'::text)$$, 'held handles are named');
select is(pg_temp.release('rules-owner-b'), 'released', 'a release deletes the handle');
select is_empty($$select * from pg_temp.current('rules-owner-b')$$, 'the owner holds none');
select is_empty($$select * from waldo.route_agent_mail('bee.two', pg_temp.at(), pg_temp.sig('mailroute.bee.two'))$$, 'a released handle no longer routes');
select is(pg_temp.release('rules-owner-b'), 'none', 'a second release finds nothing');
select is(pg_temp.claim('rules-owner-c', 'bee.two'), 'unavailable', 'a released handle is not reissued');

-- The ceiling: at 190 handles a new owner's claim stops, while a held handle can still be renamed.
insert into auth.users(id, email) select ('78000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'fill-' || n || '@test.invalid' from generate_series(1, 189) n;
insert into waldo.owners(id, auth_user_id, do_name, email)
  select ('79000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, ('78000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'fill-' || n, 'fill-' || n || '@test.invalid' from generate_series(1, 189) n;
insert into waldo.agent_mail_handles(handle, owner_id) select 'fill' || n, ('79000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, 189) n;
select is((select count(*) from waldo.agent_mail_handles), 190::bigint, 'the zone is at the ceiling');
select is(pg_temp.claim('rules-owner-c', 'late'), 'full', 'a new claim is refused at the ceiling');
select is(pg_temp.claim('rules-owner-a', 'priya.k'), 'claimed', 'a rename still goes through');

select throws_ok($$select waldo.claim_agent_mail_handle('rules-owner-a', 'x1', '2026-10-31', extract(epoch from now())::bigint, 'forged')$$, '42501', 'unsigned router call', 'a forged claim is refused');
select throws_ok(format($$select waldo.release_agent_mail_handle('rules-owner-a', %s, %L)$$, pg_temp.at(), pg_temp.sig(waldo.agent_mail_signed('mailrelease', 'rules-owner-b'))),
  '42501', 'unsigned router call', 'a release signed for another owner is refused');
select throws_ok(format($$select waldo.settle_agent_mail_rule('rules-owner-a', 'priya.k', 'live', %s, %L)$$, pg_temp.at(), pg_temp.sig(waldo.agent_mail_signed('mailsettle', 'rules-owner-a', 'priya.k', 'failed'))),
  '42501', 'unsigned router call', 'a settle signed for another outcome is refused');
select throws_ok(format($$select * from waldo.agent_mail_held_handles('priya.k,fill1', %s, %L)$$, pg_temp.at(), pg_temp.sig(waldo.agent_mail_signed('mailheld', 'priya.k'))),
  '42501', 'unsigned router call', 'a held read signed for other handles is refused');
select throws_ok(format($$select * from waldo.agent_mail_handle('rules-owner-a', %s, %L)$$, pg_temp.at(), pg_temp.sig(waldo.agent_mail_signed('mailhandle', 'rules-owner-b'))),
  '42501', 'unsigned router call', 'a handle read signed for another owner is refused');
select is(waldo.agent_mail_signed('mailclaim', 'owner-do', 'priya.k', '2026-10-31'), 'mailclaim.8:owner-do.7:priya.k.10:2026-10-31',
  'a signed message names each argument with its length, as the runtime builds it');
select isnt(waldo.agent_mail_signed('mailsettle', 'do', 'a.b', 'c'), waldo.agent_mail_signed('mailsettle', 'do', 'a', 'b.c'),
  'two different splits of the same dotted text sign differently');
select isnt(waldo.agent_mail_signed('mailclaim', 'do', null, 'x'), waldo.agent_mail_signed('mailclaim', 'do', '', 'x'), 'a null argument never signs like an empty one');
select throws_ok(format($$select waldo.claim_agent_mail_handle('rules-owner-c', 'free.2026', '10-31', %s, %L)$$, pg_temp.at(), pg_temp.sig(waldo.agent_mail_signed('mailclaim', 'rules-owner-c', 'free', '2026.10-31'))),
  '42501', 'unsigned router call', 'a claim signed for another split of handle and notice is refused');
select ok(not has_function_privilege('anon', 'waldo.agent_mail_signed(text,text[])', 'execute'), 'the signing helper is not callable from outside');
select ok(has_function_privilege('anon', f, 'execute'), format('%s is callable signed', f))
  from unnest(array['waldo.claim_agent_mail_handle(text,text,text,bigint,text)', 'waldo.release_agent_mail_handle(text,bigint,text)',
    'waldo.agent_mail_handle(text,bigint,text)', 'waldo.settle_agent_mail_rule(text,text,text,bigint,text)', 'waldo.agent_mail_held_handles(text,bigint,text)']) f;
select ok(not has_function_privilege('authenticated', f, 'execute'), format('%s is not callable by a signed-in user', f))
  from unnest(array['waldo.claim_agent_mail_handle(text,text,text,bigint,text)', 'waldo.release_agent_mail_handle(text,bigint,text)',
    'waldo.agent_mail_handle(text,bigint,text)', 'waldo.settle_agent_mail_rule(text,text,text,bigint,text)', 'waldo.agent_mail_held_handles(text,bigint,text)']) f;
select ok(not exists(select 1 from pg_proc p, lateral aclexplode(p.proacl) a
  where p.proname in ('claim_agent_mail_handle', 'release_agent_mail_handle', 'agent_mail_handle', 'settle_agent_mail_rule', 'agent_mail_held_handles')
    and p.pronamespace = 'waldo'::regnamespace and a.grantee = 0), 'no PUBLIC execution privilege');
select * from finish();
rollback;
