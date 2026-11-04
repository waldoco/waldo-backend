begin;
create extension if not exists pgtap with schema extensions;
select plan(12);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
insert into waldo.owners (do_name, email) values ('do-chat', 'c@test.invalid');

-- A catalogue app's ticket, sent to each chat surface.
select lives_ok($$ select waldo.connect_session_issue('do-chat', 'mcp:notion', 'imessage', 'hashN1', pg_temp.at(), pg_temp.sig('connsess.issue.do-chat.mcp:notion.imessage.hashN1')) $$, 'a Notion link can be sent to iMessage');
select lives_ok($$ select waldo.connect_session_issue('do-chat', 'mcp:linear', 'whatsapp', 'hashL1', pg_temp.at(), pg_temp.sig('connsess.issue.do-chat.mcp:linear.whatsapp.hashL1')) $$, 'a Linear link can be sent to WhatsApp');
select lives_ok($$ select waldo.connect_session_issue('do-chat', 'mcp:wispr', 'app', 'hashW1', pg_temp.at(), pg_temp.sig('connsess.issue.do-chat.mcp:wispr.app.hashW1')) $$, 'a Wispr Flow link can be sent to the app');
select is(waldo.connect_session_resolve('hashN1', pg_temp.at(), pg_temp.sig('connsess.resolve.hashN1'))->>'provider', 'mcp:notion', 'resolve names the app the ticket connects');

-- One live link per app, not one per owner: a new Notion link revokes the old one and leaves Linear's alone.
select waldo.connect_session_issue('do-chat', 'mcp:notion', 'imessage', 'hashN2', pg_temp.at(), pg_temp.sig('connsess.issue.do-chat.mcp:notion.imessage.hashN2'));
select is((select status from waldo.connect_sessions where ticket_hash = 'hashN1'), 'revoked', 'a new link for an app revokes that app''s earlier link');
select is((select status from waldo.connect_sessions where ticket_hash = 'hashL1'), 'issued', 'a link for another app stays live');

-- Continue runs once, whichever browser presses it.
select is(waldo.connect_session_begin('hashN2', pg_temp.at(), pg_temp.sig('connsess.begin.hashN2'))->>'do_name', 'do-chat', 'Continue on a live app ticket begins it');
select is(waldo.connect_session_begin('hashN2', pg_temp.at(), pg_temp.sig('connsess.begin.hashN2')), null, 'a second Continue finds it begun');

-- Anything that is not a catalogue-shaped id, or not a chat Waldo serves, is still refused.
select throws_ok($$ select waldo.connect_session_issue('do-chat', 'mcp:', 'app', 'hashX1', pg_temp.at(), pg_temp.sig('connsess.issue.do-chat.mcp:.app.hashX1')) $$, '23514', null, 'an empty app id is refused');
select throws_ok($$ select waldo.connect_session_issue('do-chat', 'mcp:https://evil.example', 'app', 'hashX2', pg_temp.at(), pg_temp.sig('connsess.issue.do-chat.mcp:https://evil.example.app.hashX2')) $$, '23514', null, 'an address in place of an app id is refused');
select throws_ok($$ select waldo.connect_session_issue('do-chat', 'notion', 'app', 'hashX3', pg_temp.at(), pg_temp.sig('connsess.issue.do-chat.notion.app.hashX3')) $$, '23514', null, 'a bare provider name outside the list is refused');
select throws_ok($$ select waldo.connect_session_issue('do-chat', 'mcp:notion', 'sms', 'hashX4', pg_temp.at(), pg_temp.sig('connsess.issue.do-chat.mcp:notion.sms.hashX4')) $$, '23514', null, 'an unknown channel is still refused');

select * from finish();
rollback;
