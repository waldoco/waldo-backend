-- The console session RPCs were created in 20260925010000 without revoking the
-- PUBLIC default EXECUTE, so service_role and authenticated inherited it.
-- Contract (pinned by waldo_console_sessions.sql test 2): only anon may call
-- them - the runtime uses the publishable key, and every call still needs a
-- valid router HMAC signature. Revoke PUBLIC; the explicit anon grants stand.
revoke all on function waldo.console_session_open(text, text, bigint, text) from public;
revoke all on function waldo.console_session_touch(text, text, bigint, text) from public;
revoke all on function waldo.console_session_list(text, bigint, text) from public;
revoke all on function waldo.console_session_revoke(text, text, bigint, text) from public;
revoke all on function waldo.console_signout_all(text, bigint, text) from public;
