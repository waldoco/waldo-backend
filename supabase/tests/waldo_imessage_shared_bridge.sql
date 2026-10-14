begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.rsig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.isig(op text, loc text) returns text language sql as $$
  select pg_temp.rsig('imsg.' || op || '.' || encode(extensions.digest(loc, 'sha256'), 'hex')) $$;
create function pg_temp.h(c text) returns text language sql as $$ select repeat(c, 64) $$;
create function pg_temp.bid(c text) returns text language sql as $$ select 'imb_' || repeat(c, 32) $$;
create function pg_temp.aid(c text) returns text language sql as $$ select 'ima_' || repeat(c, 32) $$;
create function pg_temp.wrapped() returns text language sql as $$ select 'v1.' || repeat('0', 24) || '.' || repeat('ab', 40) $$;

create function pg_temp.plink(o text, prov text, code text) returns boolean language sql as $$
  select waldo.issue_provider_link_code(o, prov, code, pg_temp.at(), pg_temp.rsig('link.' || prov || '.' || o || '.' || code)) $$;
create function pg_temp.tlink(o text, code text) returns boolean language sql as $$
  select waldo.issue_link_code(o, code, pg_temp.at(), pg_temp.rsig('link.' || o || '.' || code)) $$;
create function pg_temp.redeem_link(code text, prov text, subj text) returns uuid language sql as $$
  select waldo.redeem_link(code, prov, subj, pg_temp.at(), pg_temp.rsig('redeem.' || code || '.' || prov || '.' || subj)) $$;
create function pg_temp.invite(o text, code text, env text default 'test') returns boolean language sql as $$
  select waldo.imessage_issue_invitation(o, env, code, 600, jsonb_build_array(o, env, code, 600)::text, pg_temp.at(), pg_temp.isig('invite', jsonb_build_array(o, env, code, 600)::text)) $$;
create function pg_temp.invite_shared(o text, code text, env text default 'test') returns boolean language sql as $$
  select waldo.imessage_issue_shared_invitation(o, env, code, 600, jsonb_build_array(o, env, code, 600)::text, pg_temp.at(), pg_temp.isig('invite_shared', jsonb_build_array(o, env, code, 600)::text)) $$;
create function pg_temp.redeem(code text, b text, a text, env text default 'test') returns jsonb language sql as $$
  select waldo.imessage_redeem_invitation(code, env, b, a, pg_temp.wrapped(), 'host-1', 'http-v1', 'gen-1', 600,
    jsonb_build_array(code, env, b, a, pg_temp.wrapped(), 'host-1', 'http-v1', 'gen-1', 600)::text, pg_temp.at(),
    pg_temp.isig('redeem', jsonb_build_array(code, env, b, a, pg_temp.wrapped(), 'host-1', 'http-v1', 'gen-1', 600)::text)) $$;
create function pg_temp.auth(b text, a text, env text default 'test') returns jsonb language sql as $$
  select waldo.imessage_bridge_authority(env, b, a, jsonb_build_array(env, b, a)::text, pg_temp.at(), pg_temp.isig('authority', jsonb_build_array(env, b, a)::text)) $$;
create function pg_temp.sender(b text, a text, s text, env text default 'test') returns jsonb language sql as $$
  select waldo.imessage_sender_authority(env, b, a, s, jsonb_build_array(env, b, a, s)::text, pg_temp.at(), pg_temp.isig('sender', jsonb_build_array(env, b, a, s)::text)) $$;
create function pg_temp.scope(o text, b text, s text, c text, ch text) returns boolean language sql as $$
  select waldo.imessage_set_expected_scope(o, b, s, c, ch, 600, jsonb_build_array(o, b, s, c, ch, 600)::text, pg_temp.at(), pg_temp.isig('scope', jsonb_build_array(o, b, s, c, ch, 600)::text)) $$;
create function pg_temp.challenge(b text, a text, ch text, s text, c text, env text default 'test') returns boolean language sql as $$
  select waldo.imessage_record_challenge(env, b, a, ch, s, c, 'gen-1', 'event-1', pg_temp.h('d'),
    jsonb_build_array(env, b, a, ch, s, c, 'gen-1', 'event-1', pg_temp.h('d'))::text, pg_temp.at(),
    pg_temp.isig('challenge', jsonb_build_array(env, b, a, ch, s, c, 'gen-1', 'event-1', pg_temp.h('d'))::text)) $$;
create function pg_temp.activate(o text, b text, s text, c text) returns jsonb language sql as $$
  select waldo.imessage_activate(o, b, s, c, jsonb_build_array(o, b, s, c)::text, pg_temp.at(), pg_temp.isig('activate', jsonb_build_array(o, b, s, c)::text)) $$;
create function pg_temp.activate_shared(o text, b text, s text, c text) returns jsonb language sql as $$
  select waldo.imessage_activate_shared(o, b, s, c, jsonb_build_array(o, b, s, c)::text, pg_temp.at(), pg_temp.isig('activate_shared', jsonb_build_array(o, b, s, c)::text)) $$;
create function pg_temp.onboard(b text, a text, sh text, env text default 'test') returns boolean language sql as $$
  select waldo.imessage_onboarding_allowed(env, b, a, sh, jsonb_build_array(env, b, a, sh)::text, pg_temp.at(), pg_temp.isig('onboard', jsonb_build_array(env, b, a, sh)::text)) $$;
create function pg_temp.throttle(k text) returns boolean language sql as $$
  select waldo.imessage_throttle(k, 5, 3600, jsonb_build_array(k, 5, 3600)::text, pg_temp.at(), pg_temp.isig('throttle', jsonb_build_array(k, 5, 3600)::text)) $$;

insert into waldo.owners(do_name, email, is_admin) values ('sh-op', 'op@test.invalid', true), ('sh-a', 'a@test.invalid', false), ('sh-b', 'b@test.invalid', false);
update waldo.owners set phone_verified_at = now() where do_name in ('sh-a', 'sh-b');

-- Provider-scoped link codes (repairs WhatsApp linking).
select throws_ok($$ select waldo.issue_provider_link_code('sh-a','whatsapp',repeat('1',64),pg_temp.at(),'forged') $$, '42501', 'unsigned router call', 'forged provider link code refused');
select is(pg_temp.plink('sh-a', 'sms', pg_temp.h('1')), false, 'unknown provider refused');
select is(pg_temp.plink('sh-a', 'whatsapp', pg_temp.h('2')), true, 'whatsapp link code issued');
select is((select provider from waldo.link_codes where code_hash = pg_temp.h('2')), 'whatsapp', 'the code is stored as a whatsapp code');
select is(pg_temp.tlink('sh-a', pg_temp.h('3')), true, 'telegram link code issued by the original issuer');
select ok(exists (select 1 from waldo.link_codes where code_hash = pg_temp.h('2') and used_at is null), 'a telegram code no longer deletes a pending whatsapp code');
select isnt(pg_temp.redeem_link(pg_temp.h('2'), 'whatsapp', '911234567890'), null, 'a whatsapp "waldo CODE" now redeems');
select is((select o.do_name from waldo.presences p join waldo.owners o on o.id = p.owner_id where p.provider = 'whatsapp' and p.subject = '911234567890' and p.state = 'active'), 'sh-a', 'whatsapp presence linked to its own owner');

-- Shared bridge lifecycle: admin only.
select is(pg_temp.invite_shared('sh-a', pg_temp.h('4')), false, 'a non-admin cannot issue a shared invitation');
select is(pg_temp.invite_shared('sh-op', pg_temp.h('5')), true, 'the operator issues a shared invitation');
select is(pg_temp.redeem(pg_temp.h('5'), pg_temp.bid('5'), pg_temp.aid('5'))->>'bridge_id', pg_temp.bid('5'), 'host redeems the shared invitation');
select is((select kind from waldo.imessage_bridges where bridge_id = pg_temp.bid('5')), 'shared', 'the pending bridge is shared');
select is(pg_temp.auth(pg_temp.bid('5'), pg_temp.aid('5'))->>'kind', 'shared', 'bridge authority names the kind');
select is(pg_temp.scope('sh-op', pg_temp.bid('5'), 'op@icloud.test', 'iMessage;-;op@icloud.test', pg_temp.h('c')), true, 'operator sets the challenge scope');
select is(pg_temp.challenge(pg_temp.bid('5'), pg_temp.aid('5'), pg_temp.h('c'), 'op@icloud.test', 'iMessage;-;op@icloud.test'), true, 'host observes the operator challenge');
select is(pg_temp.activate('sh-op', pg_temp.bid('5'), 'op@icloud.test', 'iMessage;-;op@icloud.test'), null, 'the owner activation refuses a shared bridge');
select is(pg_temp.activate_shared('sh-a', pg_temp.bid('5'), 'op@icloud.test', 'iMessage;-;op@icloud.test'), null, 'a non-admin cannot activate a shared bridge');
select is(pg_temp.activate_shared('sh-op', pg_temp.bid('5'), 'op@icloud.test', 'iMessage;-;op@icloud.test')->>'bridge_id', pg_temp.bid('5'), 'the operator activates the shared bridge');
select is((select presence_id from waldo.imessage_bridges where bridge_id = pg_temp.bid('5')), null, 'a shared bridge carries no presence');
select is(pg_temp.auth(pg_temp.bid('5'), pg_temp.aid('5'))->>'state', 'active', 'shared bridge authority is active without a presence');
select is(pg_temp.auth(pg_temp.bid('5'), pg_temp.aid('5'))->>'subject', null, 'shared bridge authority names no subject');
select is(pg_temp.auth(pg_temp.bid('5'), pg_temp.aid('5'))->>'chat_guid', null, 'shared bridge authority names no chat');
select is(exists (select 1 from waldo.presences where provider = 'imessage' and subject = 'op@icloud.test'), false, 'activation linked no one');

-- A second shared bridge in the same environment cannot become active.
select is(pg_temp.invite_shared('sh-op', pg_temp.h('6')), true, 'second shared invitation');
select is(pg_temp.redeem(pg_temp.h('6'), pg_temp.bid('6'), pg_temp.aid('6'))->>'bridge_id', pg_temp.bid('6'), 'second shared bridge pending');
select is(pg_temp.scope('sh-op', pg_temp.bid('6'), 'op@icloud.test', 'iMessage;-;op@icloud.test', pg_temp.h('e')), true, 'second scope');
select is(pg_temp.challenge(pg_temp.bid('6'), pg_temp.aid('6'), pg_temp.h('e'), 'op@icloud.test', 'iMessage;-;op@icloud.test'), true, 'second challenge');
select is(pg_temp.activate_shared('sh-op', pg_temp.bid('6'), 'op@icloud.test', 'iMessage;-;op@icloud.test'), null, 'one active shared bridge per environment');

-- Per-sender authority on the shared bridge: each sender reaches only their own owner.
select is(pg_temp.sender(pg_temp.bid('5'), pg_temp.aid('5'), 'stranger@icloud.test')->>'state', 'unknown_sender', 'an unlinked sender is unknown');
select is(pg_temp.sender(pg_temp.bid('5'), pg_temp.aid('5'), 'stranger@icloud.test')->>'do_name', null, 'an unknown sender names no owner');
select is(pg_temp.plink('sh-a', 'imessage', pg_temp.h('7')), true, 'owner a issues an imessage link code');
select is(pg_temp.plink('sh-b', 'imessage', pg_temp.h('8')), true, 'owner b issues an imessage link code');
select isnt(pg_temp.redeem_link(pg_temp.h('7'), 'imessage', 'a@icloud.test'), null, 'owner a links their handle with "waldo CODE"');
select isnt(pg_temp.redeem_link(pg_temp.h('8'), 'imessage', '+15550000002'), null, 'owner b links their handle');
select is(pg_temp.sender(pg_temp.bid('5'), pg_temp.aid('5'), 'a@icloud.test')->>'do_name', 'sh-a', 'sender a routes to owner a');
select is(pg_temp.sender(pg_temp.bid('5'), pg_temp.aid('5'), '+15550000002')->>'do_name', 'sh-b', 'sender b routes to owner b');
select is(pg_temp.sender(pg_temp.bid('5'), pg_temp.aid('5'), 'a@icloud.test')->>'chat_guid', 'iMessage;-;a@icloud.test', 'the sender chat is the direct chat');
select is(pg_temp.sender(pg_temp.bid('5'), pg_temp.aid('5'), 'a@icloud.test')->>'kind', 'shared', 'sender authority keeps the shared kind');
select ok(pg_temp.sender(pg_temp.bid('5'), pg_temp.aid('5'), 'a@icloud.test')->>'revision' like '%.' || (select id::text from waldo.presences where subject = 'a@icloud.test' and state = 'active'),
  'the sender revision names the presence, so a relink changes it');
select is(pg_temp.redeem_link(pg_temp.h('9'), 'imessage', 'a@icloud.test'), null, 'an unknown code does not link');
select is(pg_temp.sender(pg_temp.bid('5'), pg_temp.aid('5'), 'a@icloud.test', 'other')->>'state', null, 'another environment sees nothing');
update waldo.presences set state = 'unlinked', unlinked_at = now() where provider = 'imessage' and subject = '+15550000002';
select is(pg_temp.sender(pg_temp.bid('5'), pg_temp.aid('5'), '+15550000002')->>'state', 'unknown_sender', 'an unlinked handle is unknown again');

-- Owner-kind bridges: sender authority equals the bridge authority for the bound subject only.
select is(pg_temp.invite('sh-b', pg_temp.h('a')), true, 'owner b pairs a per-owner bridge');
select is(pg_temp.redeem(pg_temp.h('a'), pg_temp.bid('a'), pg_temp.aid('a'))->>'bridge_id', pg_temp.bid('a'), 'per-owner bridge pending');
select is(pg_temp.scope('sh-b', pg_temp.bid('a'), 'b@icloud.test', 'iMessage;-;b@icloud.test', pg_temp.h('f')), true, 'per-owner scope');
select is(pg_temp.challenge(pg_temp.bid('a'), pg_temp.aid('a'), pg_temp.h('f'), 'b@icloud.test', 'iMessage;-;b@icloud.test'), true, 'per-owner challenge');
select is(pg_temp.activate('sh-b', pg_temp.bid('a'), 'b@icloud.test', 'iMessage;-;b@icloud.test')->>'bridge_id', pg_temp.bid('a'), 'per-owner bridge active');
select is(pg_temp.sender(pg_temp.bid('a'), pg_temp.aid('a'), 'b@icloud.test'), pg_temp.auth(pg_temp.bid('a'), pg_temp.aid('a')), 'owner bridge: bound sender authority equals the bridge authority');
select is(pg_temp.sender(pg_temp.bid('a'), pg_temp.aid('a'), 'a@icloud.test')->>'state', 'unknown_sender', 'owner bridge: any other sender is unknown');
-- Linking through the shared number replaces the per-owner bridge: its presence is unlinked, so it reports revoked.
select is(pg_temp.plink('sh-b', 'imessage', pg_temp.h('b')), true, 'owner b issues a new imessage link code');
select isnt(pg_temp.redeem_link(pg_temp.h('b'), 'imessage', 'b@icloud.test'), null, 'owner b links the same handle through the shared number');
select is(pg_temp.auth(pg_temp.bid('a'), pg_temp.aid('a'))->>'state', 'revoked', 'the per-owner bridge is replaced (revoked)');
select is(pg_temp.sender(pg_temp.bid('5'), pg_temp.aid('5'), 'b@icloud.test')->>'do_name', 'sh-b', 'the handle now routes through the shared bridge');

-- Onboarding replies: one per sender per 30 days, 20 per bridge per hour, shared active bridges only.
select is(pg_temp.onboard(pg_temp.bid('5'), pg_temp.aid('5'), pg_temp.h('1')), true, 'first onboarding reply allowed');
select is(pg_temp.onboard(pg_temp.bid('5'), pg_temp.aid('5'), pg_temp.h('1')), false, 'a second reply to the same sender is refused');
select is(pg_temp.onboard(pg_temp.bid('a'), pg_temp.aid('a'), pg_temp.h('2')), false, 'a per-owner bridge never sends onboarding replies');
select is(pg_temp.onboard(pg_temp.bid('5'), pg_temp.aid('5'), 'not-a-hash'), false, 'a malformed hash is refused');
select is((select count(*)::int from (select pg_temp.onboard(pg_temp.bid('5'), pg_temp.aid('5'), encode(extensions.digest('s' || g::text, 'sha256'), 'hex')) as ok from generate_series(1, 25) g) t where ok), 19,
  'at most 20 replies per bridge per hour');
select is((select count(*)::int from waldo.imessage_onboarding_replies where bridge_id = pg_temp.bid('5')), 20, 'only hashes are kept, one row per reply');
update waldo.imessage_onboarding_replies set last_sent_at = now() - interval '31 days' where subject_hash = pg_temp.h('1');
select is(pg_temp.onboard(pg_temp.bid('5'), pg_temp.aid('5'), pg_temp.h('1')), true, 'after 30 days the sender may be told again');

-- Link-code attempt throttle keys.
select is(pg_temp.throttle('imlink.sender.' || pg_temp.h('3')), true, 'imlink sender throttle key accepted');
select is(pg_temp.throttle('imother.sender.' || pg_temp.h('3')), false, 'other key shapes refused');

-- ACLs.
select ok(not has_table_privilege('anon', 'waldo.imessage_onboarding_replies', 'select'), 'onboarding replies unreachable for anon');
select ok(not has_function_privilege('anon', 'waldo.imessage_authority_json(text,text,text)', 'execute'), 'the unsigned authority body is not callable');
select ok(has_function_privilege('anon', 'waldo.imessage_sender_authority(text,text,text,text,text,bigint,text)', 'execute'), 'sender authority callable only with a router signature');

select * from finish();
rollback;
