-- WhatsApp channel (WHATSAPP_CHANNEL_SPEC_2026-09-25, W1): widen the provider literals so a
-- presence and a link code can name 'whatsapp'. Subjects are E.164 phone numbers there.
alter table waldo.presences drop constraint presences_provider_check;
alter table waldo.presences add constraint presences_provider_check check (provider in ('telegram', 'console', 'ios', 'whatsapp'));
alter table waldo.link_codes drop constraint link_codes_provider_check;
alter table waldo.link_codes add constraint link_codes_provider_check check (provider in ('telegram', 'ios', 'whatsapp'));
