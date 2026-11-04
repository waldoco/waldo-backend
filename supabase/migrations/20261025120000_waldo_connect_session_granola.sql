-- Granola connects from the app through the same first-party connect ticket as Google: single use, the
-- browser bound by the handoff code, only hashes stored. Dropped by its exact name, so a wrong name fails
-- the migration instead of leaving the narrower check in place.
alter table waldo.connect_sessions drop constraint connect_sessions_provider_check;
alter table waldo.connect_sessions add constraint connect_sessions_provider_check check (provider in ('google', 'whoop', 'granola'));
