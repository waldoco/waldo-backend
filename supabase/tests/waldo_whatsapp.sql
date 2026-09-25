begin;
create extension if not exists pgtap with schema extensions;
select plan(4);
insert into waldo.owners (do_name, email) values ('do-wa', 'wa@test.invalid');

update waldo.owners set phone_verified_at = now() where do_name = 'do-wa';
select lives_ok($$ insert into waldo.presences (owner_id, provider, subject) select id, 'whatsapp', '+15550001111' from waldo.owners where do_name = 'do-wa' $$, 'a whatsapp presence is accepted once the phone is verified');
select throws_ok($$ insert into waldo.presences (owner_id, provider, subject) select id, 'sms', '+15550002222' from waldo.owners where do_name = 'do-wa' $$, '23514', null, 'an unknown presence provider is still rejected');
select lives_ok($$ insert into waldo.link_codes (code_hash, owner_id, provider, expires_at) select 'walc1', id, 'whatsapp', now() + interval '10 minutes' from waldo.owners where do_name = 'do-wa' $$, 'a whatsapp link code is accepted');
select throws_ok($$ insert into waldo.link_codes (code_hash, owner_id, provider, expires_at) select 'walc2', id, 'sms', now() + interval '10 minutes' from waldo.owners where do_name = 'do-wa' $$, '23514', null, 'an unknown link-code provider is still rejected');

select * from finish();
rollback;
