#!/usr/bin/env bash
# Local pgTAP gate: runs supabase/tests on a FRESH PostgreSQL 15 + Supabase-compat
# shim (scripts/pgtap/shim.sql), so migration and pgTAP changes are executed in the
# lane before they ship. Fresh cluster every run = tests prove the repo, never machine
# state. Bootstraps PGDG debs into $HOME/pg15 on first run (no root needed).
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBASE="$HOME/pg15/usr/lib/postgresql/15"
DEBS="$HOME/debs"
SOCK=/tmp/pgsock-pgtap-gate
DATA="$HOME/pgtap-gate-data"
PORT=54331

if [ ! -x "$PGBASE/bin/postgres" ]; then
  echo "pgtap-gate: bootstrapping PostgreSQL 15 + pgTAP from PGDG (no root)"
  mkdir -p "$DEBS" "$HOME/pgdg/lists/partial" "$HOME/pgdg/cache/archives/partial"
  CODENAME="$( . /etc/os-release && echo "${VERSION_CODENAME:-jammy}" )"
  echo "deb http://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" > "$HOME/pgdg/sources.list"
  AOPTS="-o Dir::Etc::sourcelist=$HOME/pgdg/sources.list -o Dir::Etc::sourceparts=- -o Dir::State::lists=$HOME/pgdg/lists -o Dir::Cache=$HOME/pgdg/cache -o Acquire::AllowInsecureRepositories=true -o APT::Get::AllowUnauthenticated=true"
  apt-get $AOPTS update >/dev/null 2>&1
  (cd "$DEBS" && apt-get $AOPTS download postgresql-15 postgresql-15-pgtap >/dev/null 2>&1)
  for d in "$DEBS"/postgresql-15_*.deb "$DEBS"/postgresql-15-pgtap_*.deb; do dpkg -x "$d" "$HOME/pg15"; done
fi
[ -x "$PGBASE/bin/postgres" ] || { echo "pgtap-gate: bootstrap failed - $PGBASE/bin/postgres missing"; exit 1; }

"$PGBASE/bin/pg_ctl" -D "$DATA" -m fast stop >/dev/null 2>&1
rm -rf "$DATA" "$SOCK" && mkdir -p "$SOCK"
if ! "$PGBASE/bin/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 >"$DATA.initdb.log" 2>&1; then echo "pgtap-gate: initdb failed"; cat "$DATA.initdb.log"; exit 1; fi
"$PGBASE/bin/pg_ctl" -D "$DATA" -o "-k $SOCK -p $PORT -c listen_addresses=''" -l "$HOME/pgtap-gate.log" start >/dev/null || { echo "pgtap-gate: server start failed"; exit 1; }
trap '"$PGBASE/bin/pg_ctl" -D "$DATA" -m fast stop >/dev/null 2>&1' EXIT
sleep 1

psql -h "$SOCK" -p "$PORT" -U postgres -q -v ON_ERROR_STOP=1 -f "$ROOT/scripts/pgtap/shim.sql" >/dev/null || { echo "pgtap-gate: shim failed"; exit 1; }

for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  v=$(basename "$f" | cut -d_ -f1)
  out=$(psql -h "$SOCK" -p "$PORT" -U postgres -q -v ON_ERROR_STOP=1 -f "$f" 2>&1) || { echo "pgtap-gate: MIGRATION FAILED: $(basename $f)"; echo "$out" | head -6; exit 1; }
  psql -h "$SOCK" -p "$PORT" -U postgres -q -c "insert into supabase_migrations.schema_migrations(version,name) values ('$v','$(basename $f)');" >/dev/null
done

total_ok=0; total_notok=0; failed=0
for f in $(ls "$ROOT"/supabase/tests/*.sql | sort); do
  out=$(psql -h "$SOCK" -p "$PORT" -U postgres -q -X -A -t -f "$f" 2>&1)
  okc=$(printf '%s' "$out" | grep -c '^ok ' || true)
  notok=$(printf '%s' "$out" | grep -c '^not ok' || true)
  errs=$(printf '%s' "$out" | grep -c 'ERROR' || true)
  printf 'pgtap-gate: %-38s ok=%-4s not-ok=%-4s errors=%s\n' "$(basename $f)" "$okc" "$notok" "$errs"
  if [ "$notok" != "0" ] || [ "$errs" != "0" ]; then
    failed=1
    printf '%s' "$out" | grep -A3 -E '^not ok|# Failed|ERROR' | head -20
  fi
  total_ok=$((total_ok+okc)); total_notok=$((total_notok+notok))
done
echo "pgtap-gate: TOTAL ok=$total_ok not-ok=$total_notok"
[ "$failed" = "0" ] && [ "$total_ok" -gt 0 ] && echo "pgtap-gate: ok" || { echo "pgtap-gate: FAIL"; exit 1; }
