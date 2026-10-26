-- An owner connects a catalogue app from chat (connect_app): the ticket names the app as mcp:<catalogue id>, so issuing a
-- link for one app revokes only that app's earlier link, and it records the chat it was sent to, iMessage and WhatsApp now
-- among them. The ticket machine and its functions are unchanged. Dropped by their exact names, so a wrong name fails the
-- migration instead of leaving the narrower check in place.
alter table waldo.connect_sessions drop constraint connect_sessions_provider_check;
alter table waldo.connect_sessions add constraint connect_sessions_provider_check
  check (provider in ('google', 'whoop', 'granola') or provider ~ '^mcp:[a-z][a-z0-9-]{1,31}$');
alter table waldo.connect_sessions drop constraint connect_sessions_channel_check;
alter table waldo.connect_sessions add constraint connect_sessions_channel_check
  check (channel in ('telegram', 'console', 'app', 'imessage', 'whatsapp'));
