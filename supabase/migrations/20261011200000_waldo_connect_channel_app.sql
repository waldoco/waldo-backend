-- The app is a connect surface. A ticket it issues begins on the app runtime and the consent page
-- returns the owner to the app (waldo://oauth/complete). Dropped by its exact name, so a wrong name
-- fails the migration instead of leaving the narrower check in place.
alter table waldo.connect_sessions drop constraint connect_sessions_channel_check;
alter table waldo.connect_sessions add constraint connect_sessions_channel_check check (channel in ('telegram', 'console', 'app'));
