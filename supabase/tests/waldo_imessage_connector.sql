begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.isig(op text, loc text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.imsg.' || op || '.' || encode(extensions.digest(loc, 'sha256'), 'hex'), 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.h(c text) returns text language sql as $$ select repeat(c, 64) $$;
create function pg_temp.bid(c text) returns text language sql as $$ select 'imb_' || repeat(c, 32) $$;
create function pg_temp.aid(c text) returns text language sql as $$ select 'ima_' || repeat(c, 32) $$;
create function pg_temp.wrapped() returns text language sql as $$ select 'v1.' || repeat('0', 24) || '.' || repeat('ab', 40) $$;

create function pg_temp.invite(o text, code text, life int default 600, env text default 'test') returns boolean language sql as $$
  select waldo.imessage_issue_invitation(o, env, code, life, jsonb_build_array(o, env, code, life)::text, pg_temp.at(), pg_temp.isig('invite', jsonb_build_array(o, env, code, life)::text)) $$;
create function pg_temp.redeem(code text, b text, a text, env text default 'test', pend int default 600) returns jsonb language sql as $$
  select waldo.imessage_redeem_invitation(code, env, b, a, pg_temp.wrapped(), 'host-1', 'http-v1', 'gen-1', pend,
    jsonb_build_array(code, env, b, a, pg_temp.wrapped(), 'host-1', 'http-v1', 'gen-1', pend)::text, pg_temp.at(),
    pg_temp.isig('redeem', jsonb_build_array(code, env, b, a, pg_temp.wrapped(), 'host-1', 'http-v1', 'gen-1', pend)::text)) $$;
create function pg_temp.auth(b text, a text, env text default 'test') returns jsonb language sql as $$
  select waldo.imessage_bridge_authority(env, b, a, jsonb_build_array(env, b, a)::text, pg_temp.at(), pg_temp.isig('authority', jsonb_build_array(env, b, a)::text)) $$;
create function pg_temp.scope(o text, b text, s text, c text, ch text, life int default 600) returns boolean language sql as $$
  select waldo.imessage_set_expected_scope(o, b, s, c, ch, life, jsonb_build_array(o, b, s, c, ch, life)::text, pg_temp.at(), pg_temp.isig('scope', jsonb_build_array(o, b, s, c, ch, life)::text)) $$;
create function pg_temp.challenge(b text, a text, ch text, s text, c text, ev text default 'event-1', env text default 'test') returns boolean language sql as $$
  select waldo.imessage_record_challenge(env, b, a, ch, s, c, 'gen-1', ev, pg_temp.h('d'),
    jsonb_build_array(env, b, a, ch, s, c, 'gen-1', ev, pg_temp.h('d'))::text, pg_temp.at(),
    pg_temp.isig('challenge', jsonb_build_array(env, b, a, ch, s, c, 'gen-1', ev, pg_temp.h('d'))::text)) $$;
create function pg_temp.activate(o text, b text, s text, c text) returns jsonb language sql as $$
  select waldo.imessage_activate(o, b, s, c, jsonb_build_array(o, b, s, c)::text, pg_temp.at(), pg_temp.isig('activate', jsonb_build_array(o, b, s, c)::text)) $$;
create function pg_temp.revoke(o text, b text) returns boolean language sql as $$
  select waldo.imessage_revoke(o, b, jsonb_build_array(o, b)::text, pg_temp.at(), pg_temp.isig('revoke', jsonb_build_array(o, b)::text)) $$;
create function pg_temp.list(o text) returns jsonb language sql as $$
  select waldo.imessage_list(o, jsonb_build_array(o)::text, pg_temp.at(), pg_temp.isig('list', jsonb_build_array(o)::text)) $$;
create function pg_temp.throttle(k text, l int, w int) returns boolean language sql as $$
  select waldo.imessage_throttle(k, l, w, jsonb_build_array(k, l, w)::text, pg_temp.at(), pg_temp.isig('throttle', jsonb_build_array(k, l, w)::text)) $$;

insert into waldo.owners(do_name, email) values ('im-a', 'im-a@test.invalid'), ('im-b', 'im-b@test.invalid'), ('im-c', 'im-c@test.invalid');

-- Router authentication and locator binding.
select throws_ok($$ select waldo.imessage_issue_invitation('im-a','test',repeat('1',64),600,jsonb_build_array('im-a','test',repeat('1',64),600)::text,pg_temp.at(),'forged') $$, '42501', 'unsigned router call', 'forged invitation signature refused');
select throws_ok($$ select waldo.imessage_issue_invitation('im-a','test',repeat('1',64),600,null,null,null) $$, '42501', null, 'null router auth refused');
select throws_ok($$ select waldo.imessage_issue_invitation('im-b','test',repeat('1',64),600,jsonb_build_array('im-a','test',repeat('1',64),600)::text,pg_temp.at(),pg_temp.isig('invite',jsonb_build_array('im-a','test',repeat('1',64),600)::text)) $$, '42501', 'imessage locator mismatch', 'argument/locator mismatch refused');
select throws_ok($$ select waldo.imessage_revoke('im-a',pg_temp.bid('1'),jsonb_build_array('im-a',pg_temp.bid('1'))::text,pg_temp.at(),pg_temp.isig('list',jsonb_build_array('im-a',pg_temp.bid('1'))::text)) $$, '42501', 'unsigned router call', 'signature for another operation refused');

-- ACLs: no direct table access; functions only through anon + router signature.
select is(has_table_privilege('anon', 'waldo.imessage_bridges', 'select'), false, 'anon cannot read bridges');
select is(has_table_privilege('authenticated', 'waldo.imessage_bridges', 'select'), false, 'authenticated cannot read bridges');
select is(has_table_privilege('authenticated', 'waldo.imessage_invitations', 'insert'), false, 'authenticated cannot insert invitations');
select is(has_function_privilege('authenticated', 'waldo.imessage_activate(text,text,text,text,text,bigint,text)', 'execute'), false, 'authenticated cannot execute activation');
select is(has_function_privilege('anon', 'waldo.imessage_signed(text,text,jsonb,bigint,text)', 'execute'), false, 'internal verifier not executable');
set local role anon;
select throws_ok($$ select * from waldo.imessage_bridges $$, '42501', null, 'anon select denied');
select throws_ok($$ select waldo.imessage_activate('im-a',pg_temp.bid('1'),'s','c','[]',0,'x') $$, '42501', null, 'anon unsigned activation denied');
reset role;
set local role authenticated;
select throws_ok($$ insert into waldo.presences(owner_id,provider,subject,state) select id,'imessage','owner@example.invalid','active' from waldo.owners limit 1 $$, '42501', null, 'authenticated cannot provision an iMessage presence');
reset role;

-- Invitation: one-use, expiring, owner derived server-side.
select is(pg_temp.invite('im-a', pg_temp.h('1')), true, 'owner issues invitation');
select is(pg_temp.invite('im-b', pg_temp.h('1')), false, 'invitation hash collision never overwrites');
select is(pg_temp.invite('im-a', pg_temp.h('2'), 30), false, 'lifetime below bound refused');
select is(pg_temp.redeem(pg_temp.h('1'), pg_temp.bid('1'), pg_temp.aid('1'), 'staging'), null, 'environment mismatch refused');
select is(pg_temp.redeem(pg_temp.h('1'), pg_temp.bid('1'), pg_temp.aid('1')) ->> 'do_name', 'im-a', 'redeem binds the inviting owner, not the caller');
select is(pg_temp.redeem(pg_temp.h('1'), pg_temp.bid('2'), pg_temp.aid('2')), null, 'used invitation refused');
select is(pg_temp.redeem(pg_temp.h('9'), pg_temp.bid('2'), pg_temp.aid('2')), null, 'unknown invitation refused');
select pg_temp.invite('im-a', pg_temp.h('3'));
update waldo.imessage_invitations set created_at = now() - interval '600 seconds', expires_at = now() where code_hash = pg_temp.h('3');
select is(pg_temp.redeem(pg_temp.h('3'), pg_temp.bid('3'), pg_temp.aid('3')), null, 'expired invitation refused');
select is(pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('1')) ->> 'state', 'pending', 'redeemed bridge is pending');
select is(pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('1')) ->> 'subject', null, 'pending bridge has no subject authority');
select is(pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('1'), 'staging'), null, 'authority scoped by environment');
select is(pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('2')), null, 'authority scoped by exact account');
select is((pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('1')) ? 'key'), false, 'authority never returns a raw key field');
select pg_temp.invite('im-c', pg_temp.h('8'));
select is(pg_temp.redeem(pg_temp.h('8'), pg_temp.bid('8'), pg_temp.aid('8'), 'test', 30), null, 'pending window below bound refused');
select ok((pg_temp.redeem(pg_temp.h('8'), pg_temp.bid('8'), pg_temp.aid('8')) ->> 'expires_at_ms')::bigint > 0, 'redeem reports the pending expiry');
update waldo.imessage_bridges set pending_expires_at = now() where bridge_id = pg_temp.bid('8');
select is(pg_temp.auth(pg_temp.bid('8'), pg_temp.aid('8')) ->> 'state', 'expired', 'unverified pending credential expires');

-- Expected scope and challenge: only the exact sender/chat before expiry; one use.
select is(pg_temp.scope('im-b', pg_temp.bid('1'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid', pg_temp.h('c')), false, 'other owner cannot set scope');
select is(pg_temp.scope('im-a', pg_temp.bid('1'), 'owner@example.invalid', 'iMessage;+;chat0group', pg_temp.h('c')), false, 'group chat scope refused');
select is(pg_temp.scope('im-a', pg_temp.bid('1'), 'owner@example.invalid', 'SMS;-;+15550000001', pg_temp.h('c')), false, 'SMS chat scope refused');
select is(pg_temp.scope('im-a', pg_temp.bid('1'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid', pg_temp.h('c')), true, 'owner sets exact expected scope');
select is(pg_temp.activate('im-a', pg_temp.bid('1'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid'), null, 'setup alone cannot activate');
select is(pg_temp.challenge(pg_temp.bid('1'), pg_temp.aid('1'), pg_temp.h('e'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid'), false, 'wrong challenge refused');
select is(pg_temp.challenge(pg_temp.bid('1'), pg_temp.aid('1'), pg_temp.h('c'), 'alias@example.invalid', 'iMessage;-;owner@example.invalid'), false, 'alias sender refused');
select is(pg_temp.challenge(pg_temp.bid('1'), pg_temp.aid('1'), pg_temp.h('c'), 'owner@example.invalid', 'iMessage;-;other@example.invalid'), false, 'other chat refused');
select is(pg_temp.challenge(pg_temp.bid('1'), pg_temp.aid('2'), pg_temp.h('c'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid'), false, 'other account refused');
update waldo.imessage_bridges set challenge_expires_at = now() where bridge_id = pg_temp.bid('1');
select is(pg_temp.challenge(pg_temp.bid('1'), pg_temp.aid('1'), pg_temp.h('c'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid'), false, 'expired challenge refused');
select is(pg_temp.scope('im-a', pg_temp.bid('1'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid', pg_temp.h('f')), true, 'fresh challenge reissued');
select is(pg_temp.challenge(pg_temp.bid('1'), pg_temp.aid('1'), pg_temp.h('f'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid'), true, 'exact challenge observed');
select is(pg_temp.challenge(pg_temp.bid('1'), pg_temp.aid('1'), pg_temp.h('f'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid', 'event-2'), false, 'challenge replay refused');
select is(pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('1')) ->> 'challenge_hash', null, 'consumed challenge no longer advertised');

-- Activation: owner confirms the exact observed scope.
select is(pg_temp.activate('im-b', pg_temp.bid('1'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid'), null, 'other owner cannot activate');
select is(pg_temp.activate('im-a', pg_temp.bid('1'), 'alias@example.invalid', 'iMessage;-;owner@example.invalid'), null, 'confirmation of a different scope refused');
create temp table first_rev as select pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('1')) ->> 'revision' as rev;
select is(pg_temp.activate('im-a', pg_temp.bid('1'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid') ->> 'subject', 'owner@example.invalid', 'verified positive activation');
select is(pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('1')) ->> 'state', 'active', 'authority active');
select is(pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('1')) ->> 'chat_guid', 'iMessage;-;owner@example.invalid', 'authority carries exact chat');
select isnt(pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('1')) ->> 'revision', (select rev from first_rev), 'activation changes the revision');
select is((select do_name from waldo.route_presence('imessage', 'owner@example.invalid', pg_temp.at(),
  encode(extensions.hmac(pg_temp.at()::text || '.route.imessage.owner@example.invalid', 'test-router-secret', 'sha256'), 'hex'))), 'im-a', 'active binding routes through the existing presence directory');
select is(pg_temp.activate('im-a', pg_temp.bid('1'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid'), null, 'observation consumed; second activation refused');
select is(jsonb_array_length(pg_temp.list('im-a')), 1, 'owner lists own bridge');
select is(pg_temp.list('im-a')::text ~ 'wrapped|v1\.0', false, 'status list carries no credential');
select is(jsonb_array_length(pg_temp.list('im-b')), 0, 'status scoped to owner');

-- Live-subject uniqueness and one active binding per owner.
select pg_temp.invite('im-b', pg_temp.h('4'));
select pg_temp.redeem(pg_temp.h('4'), pg_temp.bid('4'), pg_temp.aid('4'));
select pg_temp.scope('im-b', pg_temp.bid('4'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid', pg_temp.h('a'));
select pg_temp.challenge(pg_temp.bid('4'), pg_temp.aid('4'), pg_temp.h('a'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid');
select is(pg_temp.activate('im-b', pg_temp.bid('4'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid'), null, 'live subject already bound to another owner: conflict, not transfer');
select is(pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('1')) ->> 'do_name', 'im-a', 'first owner binding unchanged');
select pg_temp.invite('im-a', pg_temp.h('5'));
select pg_temp.redeem(pg_temp.h('5'), pg_temp.bid('5'), pg_temp.aid('5'));
select pg_temp.scope('im-a', pg_temp.bid('5'), 'second@example.invalid', 'iMessage;-;second@example.invalid', pg_temp.h('b'));
select pg_temp.challenge(pg_temp.bid('5'), pg_temp.aid('5'), pg_temp.h('b'), 'second@example.invalid', 'iMessage;-;second@example.invalid');
select is(pg_temp.activate('im-a', pg_temp.bid('5'), 'second@example.invalid', 'iMessage;-;second@example.invalid'), null, 'second active binding for one owner refused');

-- Suspension invalidates authority; reactivation restores it with a new revision.
create temp table pre_suspend as select pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('1')) ->> 'revision' as rev;
update waldo.owners set state = 'suspended' where do_name = 'im-a';
select is(pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('1')) ->> 'state', 'owner_inactive', 'suspended owner has no authority');
select is(pg_temp.invite('im-a', pg_temp.h('6')), false, 'suspended owner cannot invite');
update waldo.owners set state = 'active' where do_name = 'im-a';
select isnt(pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('1')) ->> 'revision', (select rev from pre_suspend), 'suspend/resume invalidates the old revision');

-- Revoke: authority first, then presence unlink; no reactivation of the same bridge.
select is(pg_temp.revoke('im-b', pg_temp.bid('1')), false, 'other owner cannot revoke');
select is(pg_temp.revoke('im-a', pg_temp.bid('1')), true, 'owner revokes');
select is(pg_temp.auth(pg_temp.bid('1'), pg_temp.aid('1')) ->> 'state', 'revoked', 'revoked authority');
select is((select count(*)::int from waldo.presences where provider = 'imessage' and subject = 'owner@example.invalid' and state = 'active'), 0, 'presence unlinked on revoke');
select is(pg_temp.revoke('im-a', pg_temp.bid('1')), false, 'revoke is not repeatable');
select is(pg_temp.activate('im-b', pg_temp.bid('4'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid') ->> 'subject', 'owner@example.invalid', 'after revoke the subject can be bound by a fresh pairing');
select is(pg_temp.scope('im-a', pg_temp.bid('1'), 'owner@example.invalid', 'iMessage;-;owner@example.invalid', pg_temp.h('7')), false, 'revoked bridge cannot be re-scoped');

-- Unlinking the presence elsewhere reads as revoked; owner deletion cascades.
update waldo.presences set state = 'unlinked', unlinked_at = now() where provider = 'imessage' and subject = 'owner@example.invalid' and state = 'active';
select is(pg_temp.auth(pg_temp.bid('4'), pg_temp.aid('4')) ->> 'state', 'revoked', 'unlinked presence revokes authority');
delete from waldo.owners where do_name = 'im-b';
select is(pg_temp.auth(pg_temp.bid('4'), pg_temp.aid('4')), null, 'owner deletion removes bridge authority');
select is((select count(*)::int from waldo.imessage_invitations i join waldo.owners o on o.id = i.owner_id where o.do_name = 'im-b'), 0, 'owner deletion removes invitations');

-- Durable throttle windows.
select is(pg_temp.throttle('imredeem.code.' || pg_temp.h('1'), 2, 60), true, 'throttle admits 1');
select is(pg_temp.throttle('imredeem.code.' || pg_temp.h('1'), 2, 60), true, 'throttle admits 2');
select is(pg_temp.throttle('imredeem.code.' || pg_temp.h('1'), 2, 60), false, 'throttle refuses 3');
select is(pg_temp.throttle('device.code.' || pg_temp.h('1'), 2, 60), false, 'foreign throttle namespace refused');

select * from finish();
rollback;
