-- One database call for a run's late days. waldo.health_context_write_batch takes a signed JSON array of up to thirty rows,
-- each the payload waldo.health_context_write takes, and writes them oldest first in one transaction by calling that writer for
-- each. It re-implements none of the writer's checks, so every change the writer gets (columns, rules, fences) is the batch's
-- too. The answers are the writer's own, one per row in order: { "results": [...] }. A consent or epoch refusal
-- (consent_required, epoch_conflict) is answered in its row's place and ends the batch, so no row after it is written and the
-- rows before it stay written. Every other answer (written, stale, invalid_request, not_linked) is kept and the batch goes on,
-- as the runtime's one-at-a-time loop did. Nothing is caught: an error the writer raises aborts the whole call.
--
-- The writer checks a signature over each payload, so the batch checks its own signature over the whole array (message
-- health.context_write_batch.<do_name>.<md5 of the payload>, the same Vault secret and clock window) and then signs each row
-- for the writer in the database, with the secret router_signed reads. The secret never leaves the function and nothing but
-- the writer is signed with it here. Security definer, empty search path and grants are those of the other health functions.
create function waldo.health_context_write_batch(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rows jsonb; v_row jsonb; v_text text; v_one jsonb; v_secret text; v_at bigint; v_results jsonb := '[]'::jsonb;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.context_write_batch.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if octet_length(p_payload) > 524288 then return '{"error":"invalid_request"}'; end if;
  begin v_rows := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_rows) is distinct from 'array' or jsonb_array_length(v_rows) not between 1 and 30 then return '{"error":"invalid_request"}'; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'waldo_router_hmac';
  v_at := extract(epoch from now())::bigint;
  for v_row in select value from jsonb_array_elements(v_rows) loop
    v_text := v_row::text;
    v_one := waldo.health_context_write(p_do_name, v_text, v_at,
      encode(extensions.hmac(v_at::text || '.health.context_write.' || p_do_name || '.' || md5(v_text), v_secret, 'sha256'), 'hex'));
    v_results := v_results || jsonb_build_array(v_one);
    exit when v_one->>'error' in ('consent_required', 'epoch_conflict');
  end loop;
  return jsonb_build_object('results', v_results);
end $$;

revoke all on function waldo.health_context_write_batch(text, text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.health_context_write_batch(text, text, bigint, text) to anon;
