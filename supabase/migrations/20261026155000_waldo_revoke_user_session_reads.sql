-- No Supabase user session reads or writes these tables. The Worker and the edge functions reach them through signed
-- security-definer RPCs, and the app talks only to the Worker, with its own bearer. Supabase hands a user session to
-- anyone it can authenticate (an email code, Apple, Google) through the publishable key the app ships, so these grants
-- let such a session read an owner's row, linked handles and settings, change the settings, and read the owner's derived
-- health context, all without Waldo.
drop policy owners_self on waldo.owners;
drop policy presences_self on waldo.presences;
drop policy settings_self_read on waldo.owner_settings;
drop policy settings_self_write on waldo.owner_settings;
-- Every table in the schema, including any a dashboard default granted: the signed RPCs run as their owner.
revoke all on all tables in schema waldo from anon, authenticated;
revoke all on all sequences in schema waldo from anon, authenticated;
revoke all on function waldo.current_owner() from public, anon, authenticated;
-- anon keeps schema usage: it is the role the Worker's signed RPC calls arrive as.
revoke usage on schema waldo from authenticated;

drop policy "own rows" on public.health_context_daily;
revoke all on table public.health_context_daily from anon, authenticated;
