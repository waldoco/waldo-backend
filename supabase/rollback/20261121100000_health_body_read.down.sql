-- Rolls back 20261121100000: drops the model's body read and its history read. They hold and changed nothing else, so nothing else
-- is restored. Run only after the Worker's HEALTH_BODY_CONTEXT switch is 0; with it on, a missing function only leaves the body
-- words out of the block and get_crs answering that the read failed.
drop function waldo.health_body_read(text,text,bigint,text);
drop function waldo.health_body_history(text,text,bigint,text);
