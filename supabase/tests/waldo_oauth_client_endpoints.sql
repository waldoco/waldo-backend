begin;
create extension if not exists pgtap with schema extensions;
select plan(28);

select is(has_function_privilege('anon', 'waldo.oauth_client_seed(text, text, text, text, text, text, text)', 'execute'), false, 'the runtime key cannot seed a client');
select is(has_function_privilege('authenticated', 'waldo.oauth_client_seed(text, text, text, text, text, text, text)', 'execute'), false, 'a signed-in user cannot seed a client');
select is(has_function_privilege('anon', 'waldo.oauth_client_registered(text, text)', 'execute'), false, 'the runtime key cannot read a pre-registered client');
select is(has_function_privilege('anon', 'waldo.oauth_client_secret(text, text, text, text)', 'execute'), false, 'the runtime key cannot read a client secret');
select is(has_function_privilege('authenticated', 'waldo.oauth_client_secret(text, text, text, text)', 'execute'), false, 'a signed-in user cannot read a client secret');
select is(has_function_privilege('service_role', 'waldo.oauth_client_secret(text, text, text, text)', 'execute'), true, 'the edge reads a client secret');

-- Seeding: the operator enters a pre-registered confidential client with the endpoints its secret may reach.
select is(waldo.oauth_client_seed('https://mcp.chat.example', 'https://w.example/oauth/mcp/callback', 'chat-client', 'client_secret_post', 'chat-secret-1', 'https://chat.example/api/token', null), true, 'a pre-registered client is seeded');
select is((select count(*)::int from waldo.oauth_clients m join vault.secrets s on s.id = m.secret_id where m.issuer = 'https://mcp.chat.example' and s.secret like '%chat-secret%'), 0, 'its secret is held in Vault, encrypted');
select results_eq($$ select client_id, client_auth from waldo.oauth_client_registered('https://mcp.chat.example', 'https://w.example/oauth/mcp/callback') $$,
  $$ values ('chat-client', 'client_secret_post') $$, 'the lookup names the client and its authentication');

-- The secret goes only to the endpoints the row pins.
select is(waldo.oauth_client_secret('https://mcp.chat.example', 'https://w.example/oauth/mcp/callback', 'chat-client', 'https://chat.example/api/token'), 'chat-secret-1', 'the secret is read for the pinned token endpoint');
select is(waldo.oauth_client_secret('https://mcp.chat.example', 'https://w.example/oauth/mcp/callback', 'chat-client', 'https://evil.example/token'), null, 'a secret aimed at another endpoint is refused');
select is(waldo.oauth_client_secret('https://mcp.chat.example', 'https://w.example/oauth/mcp/callback', 'chat-client', null), null, 'a secret aimed at no endpoint is refused');
select is(waldo.oauth_client_secret('https://mcp.chat.example', 'https://w.example/oauth/mcp/callback', 'other-client', 'https://chat.example/api/token'), null, 'a secret for another client id is refused');
select is(waldo.oauth_client_secret('https://mcp.chat.example', 'https://other.example/oauth/mcp/callback', 'chat-client', 'https://chat.example/api/token'), null, 'a secret for another redirect address is refused');

-- Seeding again rotates the secret in place.
select is(waldo.oauth_client_seed('https://mcp.chat.example', 'https://w.example/oauth/mcp/callback', 'chat-client', 'client_secret_post', 'chat-secret-2', 'https://chat.example/api/token', 'https://chat.example/api/revoke'), true, 'seeding again is accepted');
select is((select count(*)::int from waldo.oauth_clients where issuer = 'https://mcp.chat.example'), 1, 'and keeps one row');
select is(waldo.oauth_client_secret('https://mcp.chat.example', 'https://w.example/oauth/mcp/callback', 'chat-client', 'https://chat.example/api/token'), 'chat-secret-2', 'with the rotated secret');
select is(waldo.oauth_client_secret('https://mcp.chat.example', 'https://w.example/oauth/mcp/callback', 'chat-client', 'https://chat.example/api/revoke'), 'chat-secret-2', 'readable for its pinned revocation endpoint too');
select is((select count(*)::int from vault.decrypted_secrets where decrypted_secret like 'chat-secret%'), 1, 'and no stale secret left in Vault');

-- Refusals at seeding.
select is(waldo.oauth_client_seed('https://mcp.chat.example', 'https://w.example/cb2', 'chat-client', 'client_secret_post', null, 'https://chat.example/api/token', null), false, 'a confidential client without a secret is refused');
select is(waldo.oauth_client_seed('https://mcp.chat.example', 'https://w.example/cb2', 'chat-client', 'client_secret_post', 's', 'http://chat.example/api/token', null), false, 'a plain-http token endpoint is refused');
select is(waldo.oauth_client_seed('https://mcp.chat.example', 'https://w.example/cb2', 'chat-client', null, 's', 'https://chat.example/api/token', null), false, 'a missing client authentication is refused');

-- A dynamic registration is not a pre-registered client, and keeps its older read.
select is(waldo.oauth_client_put('https://auth.example.com', 'https://w.example/oauth/mcp/callback', 'dcr-client', 'client_secret_basic', 'dcr-secret'), true, 'a dynamic registration is stored');
select is((select count(*)::int from waldo.oauth_client_registered('https://auth.example.com', 'https://w.example/oauth/mcp/callback')), 0, 'and is never answered as pre-registered');
select is(waldo.oauth_client_secret('https://auth.example.com', 'https://w.example/oauth/mcp/callback', 'dcr-client', 'https://auth.example.com/token'), 'dcr-secret', 'its secret is read without a pinned endpoint, as before');

-- A confidential client seeded again as a public one keeps one row and leaves no secret in Vault.
select is(waldo.oauth_client_seed('https://mcp.chat.example', 'https://w.example/oauth/mcp/callback', 'chat-client', 'none', null, 'https://chat.example/api/token', null), true, 'a client seeded again as public is accepted');
select results_eq($$ select client_id, client_auth from waldo.oauth_client_registered('https://mcp.chat.example', 'https://w.example/oauth/mcp/callback') $$,
  $$ values ('chat-client', 'none') $$, 'and is looked up as public');
select is((select count(*)::int from vault.decrypted_secrets where decrypted_secret like 'chat-secret%'), 0, 'and its old secret is gone from Vault');

select * from finish();
rollback;
