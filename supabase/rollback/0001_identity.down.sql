-- DOWN for 0001_identity.sql. Run last (after all child tables are dropped).
drop table if exists user_consents cascade;
drop function if exists app_user_id();
drop table if exists users cascade;
