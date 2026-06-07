# Waldo Worker Environment

## Non-secret vars

- `ENVIRONMENT`: `local`, `staging`, or `production`.
- `SUPABASE_URL`: Supabase project URL for the target environment.
- `WALDO_WORKER_URL`: Public Worker URL consumed by app/backend callers after deploy.

## Secrets

No Worker secrets are required for HEY-71.

Do not add `SUPABASE_SERVICE_ROLE_KEY` to this Worker. Service-role access is Edge Function/admin only; the Durable Object agent loop must not hold it.
