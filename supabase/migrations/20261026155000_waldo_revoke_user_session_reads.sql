-- No Supabase user session reads or writes these tables. The Worker and the edge functions reach them through signed
-- security-definer RPCs, and the app talks only to the Worker, with its own bearer. Supabase hands a user session to
-- anyone it can authenticate (an email code, Apple, Google) through the publishable key the app ships, so these grants
-- let such a session read an owner's row, linked handles and settings, change the settings, and read the owner's derived
-- health context, all without Waldo.
drop policy if exists owners_self on waldo.owners;
drop policy if exists presences_self on waldo.presences;
drop policy if exists settings_self_read on waldo.owner_settings;
drop policy if exists settings_self_write on waldo.owner_settings;
-- Every table in the schema, including any a dashboard default granted: the signed RPCs run as their owner.
revoke all on all tables in schema waldo from anon, authenticated;
revoke all on all sequences in schema waldo from anon, authenticated;
revoke all on function waldo.current_owner() from public, anon, authenticated;
-- anon keeps schema usage: it is the role the Worker's signed RPC calls arrive as.
revoke usage on schema waldo from authenticated;

drop policy if exists "own rows" on public.health_context_daily;
revoke all on table public.health_context_daily from anon, authenticated;

-- The July app tables: raw health days, scores, chats, consents, devices. Nothing reads them as a user session; the app
-- talks only to the Worker, and the Worker and edge functions use signed RPCs or the service role.
drop policy if exists users_select_own on public.users;
drop policy if exists user_consents_select_own on public.user_consents;
drop policy if exists health_daily_select_own on public.health_daily;
drop policy if exists crs_scores_select_own on public.crs_scores;
drop policy if exists user_baselines_select_own on public.user_baselines;
drop policy if exists spots_select_own on public.spots;
drop policy if exists patrol_entries_select_own on public.patrol_entries;
drop policy if exists feedback_signals_select_own on public.feedback_signals;
drop policy if exists chat_threads_select_own on public.chat_threads;
drop policy if exists chat_messages_select_own on public.chat_messages;
drop policy if exists user_devices_select_own on public.user_devices;
drop policy if exists subscriptions_select_own on public.subscriptions;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Supabase grants anon and authenticated everything on tables postgres creates in public; a new table would arrive
-- readable by a user session. Functions keep their defaults: each RPC's grant is explicit in its migration.
alter default privileges for role postgres in schema waldo revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema waldo revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
