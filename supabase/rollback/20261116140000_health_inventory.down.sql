-- Rolls back 20261116140000: drops the inventory read. It holds and changed nothing else, so nothing else is restored. Run only
-- after the Worker's HEALTH_INVENTORY switch is 0; with it on, a missing function only leaves the inventory out of the block.
drop function waldo.health_inventory_read(text,text,bigint,text);
