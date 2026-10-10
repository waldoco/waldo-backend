# Historical inactive candidate (superseded)

`presence-provider.sql`, `inactive-tests.sql` and `prove-inactive.mjs` are the S1/S3-preparation proof that
an *inactive-only* iMessage presence could be added without changing other providers. They are kept as
historical evidence and remain outside migration discovery.

The canonical migration `supabase/migrations/20261010120000_waldo_imessage_connector.sql` supersedes the
candidate: it adds `imessage` to `presences_provider_check` and allows **active** iMessage presences, but
only through the router-signed activation writer (`waldo.imessage_activate`) after an owner-confirmed,
host-observed challenge. Positive activation, concurrency, revoke and deletion are proven by
`supabase/tests/waldo_imessage_connector.sql` and `packages/runtime/scripts/imessage-local-trace.mjs`.
