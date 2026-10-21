-- Candidate only: do not apply until reviewed owner-presence setup exists.
begin;
alter table waldo.presences drop constraint presences_provider_check;
alter table waldo.presences add constraint presences_provider_check
  check (provider in ('telegram', 'console', 'ios', 'whatsapp', 'imessage'));
alter table waldo.presences add constraint presences_imessage_scaffold_inactive
  check (provider <> 'imessage' or state <> 'active');
rollback;
