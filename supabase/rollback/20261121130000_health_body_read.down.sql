-- Rolls back 20261121130000: drops the model's body read. It holds and changed nothing else, so nothing else is restored. Run only
-- after the Worker's HEALTH_BODY_CONTEXT switch is 0; with it on, a missing function only leaves the body words out of the block.
drop function waldo.health_body_read(text,text,bigint,text);
