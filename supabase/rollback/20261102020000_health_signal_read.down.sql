-- Rolls back 20261102020000_health_signal_read.sql. Set HEALTH_SIGNALS_READ to 0 first, or the route answers unavailable for every request.
drop function if exists waldo.health_signal_read(text, text, bigint, text);
