create extension if not exists pgtap with schema extensions;
create view public.imessage_proof_current as
select 'constraint' as kind, c.oid::text as identity, pg_get_constraintdef(c.oid) as definition
from pg_constraint c where c.conrelid in ('waldo.presences'::regclass, 'waldo.link_codes'::regclass)
union all
select 'table', c.oid::text, concat(c.relrowsecurity, ':', c.relforcerowsecurity, ':', c.relacl::text)
from pg_class c where c.relnamespace = 'waldo'::regnamespace
union all
select 'function', p.oid::text, concat(pg_get_functiondef(p.oid), ':', p.proacl::text)
from pg_proc p where p.pronamespace = 'waldo'::regnamespace
union all
select 'policy', oid::text, concat(polname, ':', polroles::text, ':', pg_get_expr(polqual, polrelid), ':', pg_get_expr(polwithcheck, polrelid))
from pg_policy where polrelid in (select oid from pg_class where relnamespace = 'waldo'::regnamespace)
union all
select 'index', indexrelid::text, pg_get_indexdef(indexrelid) from pg_index where indrelid = 'waldo.presences'::regclass;
create table public.imessage_proof_catalog as select * from public.imessage_proof_current;
select version();
