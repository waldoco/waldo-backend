#!/usr/bin/env bash
# One-command owner wiring: migrations -> schema exposure -> router HMAC (Vault + worker) -> owner seed -> live verify.
# Run from the repo root on the Mac: bash scripts/owner_wire_supabase.sh
# Reads values from .env in the repo root. Never prints secret values. Idempotent: safe to re-run.
set -euo pipefail

[ -f .env ] && { set -a; . ./.env; set +a; }
missing=""
for v in SUPABASE_PROJECT_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD CLOUDFLARE_API_TOKEN WALDO_OWNER_TELEGRAM_ID; do
  eval "test -n \"\${$v:-}\"" || missing="$missing $v"
done
if [ -n "$missing" ]; then
  echo "Add these to .env and re-run:$missing"
  echo "(WALDO_OWNER_TELEGRAM_ID is your numeric Telegram user id.)"
  exit 1
fi
REF=$(printf '%s' "$SUPABASE_PROJECT_URL" | sed -E 's|https://([a-z0-9]+)\..*|\1|')
TID="$WALDO_OWNER_TELEGRAM_ID"
q() { curl -sf -X POST "https://api.supabase.com/v1/projects/$REF/database/query" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'content-type: application/json' -d "$1"; }

echo "== 1/5 link + migrations (project $REF)"
npx --yes supabase link --project-ref "$REF" --password "$SUPABASE_DB_PASSWORD"
npx --yes supabase db push

echo "== 2/5 expose waldo schema"
if ! curl -sf -X PATCH "https://api.supabase.com/v1/projects/$REF/postgrest" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'content-type: application/json' -d '{"db_schema":"public,waldo"}' >/dev/null 2>&1; then
  echo "  API shape changed - do it in the dashboard: Project Settings -> API -> Exposed schemas -> add 'waldo', then re-run."
  exit 1
fi

echo "== 3/5 router HMAC: generate, vault, worker"
HMAC=$(openssl rand -hex 32)
q "{\"query\": \"select vault.create_secret('$HMAC', 'waldo_router_hmac') where not exists (select 1 from vault.secrets where name = 'waldo_router_hmac')\"}" >/dev/null
printf '%s' "$HMAC" | npx --yes wrangler secret put WALDO_ROUTER_HMAC_SECRET --name waldo-runtime-staging >/dev/null
printf '%s' "$SUPABASE_PROJECT_URL" | npx --yes wrangler secret put SUPABASE_PROJECT_URL --name waldo-runtime-staging >/dev/null
printf '%s' "$SUPABASE_PUBLISHABLE_KEY" | npx --yes wrangler secret put SUPABASE_PUBLISHABLE_KEY --name waldo-runtime-staging >/dev/null

echo "== 4/5 seed owner row"
q "{\"query\": \"insert into waldo.owners (do_name, email) values ('$TID', coalesce(nullif('${WALDO_OWNER_EMAIL:-}',''), null)) on conflict (do_name) do nothing\"}" >/dev/null
q "{\"query\": \"insert into waldo.presences (owner_id, provider, subject) select id, 'telegram', '$TID' from waldo.owners where do_name = '$TID' on conflict (provider, subject) where state = 'active' do nothing\"}" >/dev/null
q "{\"query\": \"insert into waldo.owner_settings (owner_id, timezone) select id, 'Asia/Calcutta' from waldo.owners where do_name = '$TID' on conflict (owner_id) do nothing\"}" >/dev/null

echo "== 5/5 live verify"
AT=$(date +%s)
SIG=$(printf '%s' "$AT.route.telegram.$TID" | openssl dgst -sha256 -hmac "$HMAC" | awk '{print $NF}')
GOOD=$(curl -s -X POST "$SUPABASE_PROJECT_URL/rest/v1/rpc/route_presence" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-profile: waldo' -H 'content-type: application/json' -d "{\"p_provider\":\"telegram\",\"p_subject\":\"$TID\",\"p_at\":$AT,\"p_sig\":\"$SIG\"}")
echo "  signed route_presence: $GOOD (want a row with do_name $TID)"
unset HMAC SIG
BAD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$SUPABASE_PROJECT_URL/rest/v1/rpc/route_presence" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'content-profile: waldo' -H 'content-type: application/json' -d "{\"p_provider\":\"telegram\",\"p_subject\":\"$TID\",\"p_at\":$AT,\"p_sig\":\"deadbeef\"}")
echo "  unsigned call rejected with HTTP $BAD (want 400)"
ROWS=$(q "{\"query\": \"select o.do_name, p.provider, p.subject, s.timezone from waldo.presences p join waldo.owners o on o.id = p.owner_id left join waldo.owner_settings s on s.owner_id = o.id where p.subject = '$TID'\"}")
echo "  owner row as the runtime will route it: $ROWS"
echo "Done."
