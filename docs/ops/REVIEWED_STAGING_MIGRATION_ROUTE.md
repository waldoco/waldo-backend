# Pinned staging migration route

October 1, 2026. Source preparation only. No hosted apply or history read has succeeded.

The staging project is pinned to `togdshayyxycitzckpqv`. `operation=deploy` remains
its current default and now rejects legacy `run_migrations=true` rather than silently
combining database and Worker changes. `operation=preflight` reads history only.
`operation=migration-apply` is a separate, explicit job, never a deployment step.
Main is unchanged. Always select `--ref beta-mvp`; main still has the older workflow.

## Review and run

1. Review this source at its exact SHA and require all normal CI jobs green.
2. Run the read-only preflight at the intended merged SHA. Review each pending
   filename, byte count, SQL SHA256, and the full migration semantics. History must
   be an exact canonical prefix. A versions-only match does not prove applied SQL bytes.
3. Independently establish owner permission for those SQL effects. A prepared route,
   reviewed source or repository access is not permission to apply hosted changes.
4. Pass that SHA and the packet's `pendingManifestSha256` to the explicit apply job.
   Missing/mismatched source, dirty/untracked files, target, history or digest stops it.
5. The pinned CLI links in an isolated temporary checkout containing only regular migration files and a minimal generated config, rejecting source symlinks, nested env/cache/branches using environment-only
   credentials. Check the link result, run `db push --linked --dry-run`, reread
   history, source, copied bytes and the entire effective linked config immediately before applying, then `db push --linked --yes`.
   No `include-all`, seed, roles, repair, management-API SQL version invention or
   Worker deployment. Credentials and raw provider stdout/stderr are not printed.
6. Read history after application and require the entire canonical manifest present.
   The receipt reports versions and the reviewed pending digest, not verified hosted
   SQL digests. Recheck the application through live E2E after separate Worker promotion.

One workflow apply runs at a time without cancelling an active apply. This does not
lock out SQL writers outside this workflow. Freeze other migration writers during the
run; if that cannot be established, do not run it. API preflight and CLI see history
through different mechanisms, and there is no atomic compare-and-apply operation.
A provider failure, timeout, partial result or failed post-read is unconfirmed, not
safe to retry. The process timeout does not guarantee process-tree cancellation. Read live history and inspect the affected schema before deciding.
Forward migrations are the default rollback; no automatic SQL undo is claimed.

## Current execution gap

Manual dispatch currently returns 422 (`Actions has been disabled for this user`)
for the authenticated `Pin4sf` account, while repository Actions reads report enabled.
This source does not fix that account-level problem or change any settings.
Staging Worker promotion worked through existing Cloudflare builds separately.
A working read-only history route, exact pending review, owner authority and a usable
apply executor are still needed before hosted SQL can run.

Sources consulted:
- https://supabase.com/docs/reference/cli/supabase-db-push : canonical CLI history,
  dry-run and linked behavior.
- https://supabase.com/docs/reference/api/v1-apply-a-migration : no explicit canonical
  timestamp-version parameter established; do not use it to invent migration history.
- Live `supabase@2.109.1 db push --help` and `link --help`: pinned flag verification,
  only help executed without linking or accessing a project.

The workflow does not enforce beta-only dispatch; the recipe selects beta explicitly.
Credentials are the existing staging secrets; scope/exclusivity is not proved.

CLI process environment uses a fresh HOME and XDG/TMP roots inside the isolated
workdir and an explicit `--profile supabase` on every call. Root/parent dotenv is
rejected before link and before write. Effective config digest covers linked temp
metadata and all copied SQL, without printing their content. The pinned CLI profile
source confirms the standard profile uses api.supabase.com and standard hosts.
https://github.com/supabase/cli/blob/v2.109.1/apps/cli-go/internal/utils/profile.go
