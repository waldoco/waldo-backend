-- DOWN for 0005_integrations.sql. Apply rollbacks in reverse migration order
-- (0005 → 0001). Not run by `supabase db push`; apply manually via psql if reverting.
drop table if exists subscriptions cascade;
drop table if exists one_time_tokens cascade;
drop table if exists oauth_tokens cascade;
drop table if exists user_devices cascade;
