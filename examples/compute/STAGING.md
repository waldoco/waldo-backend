# Private compute/files hosted finish path

Prepared source only. Current base473be9aa is reportedly serving successfully and Core's five-prompt soak holds additional staging deployments. This preparation changes no shared runtime deployment configuration or browser source, and makes no hosted provider call. Parent owns PR906 review/merge/release disposition. Kennel excluded.

## Exact resources/configuration

Official Wrangler4.141 or later is needed for this native dynamic Container proposal; serving dependency remains locked4.135. `wrangler.staging.jsonc` defines private waldo-owner-compute-staging, one SQLite-backed OwnerComputeContainer namespace, dynamic Container application and pinned Node image in account managed registry. No public route, workers.dev/preview URL, HTTP acceptance path, new RPC, observability, outbound intercept, secrets, new R2 or database bindings. Optional runtime staging binding is `{ "binding":"COMPUTE", "service":"waldo-owner-compute-staging" }`; release owner adds it to the complete current service list without dropping existing bindings. Runtime already derives scope from physical owner DO ID.

staging-worker checks one exact canonical owner scope before DO allocation for execute/recover/cancel. Operator obtains scope through their existing trusted mapping; no cross-task identity transfer, model field, invented UUID or new credential. Generate an ignored mode0600 source roster:

```sh
node examples/compute/staging-owner-roster.mjs --owner-scope "$reviewed_owner_scope"
```

Default checkout/build generates deny-all; no-arg builds preserve explicitly generated roster. Never commit .staging/owner-roster.ts. `--clear denied` resets activation. This limits paid test calls, not a new persistent owner permission.

Local preparation commands:

```sh
node examples/compute/staging-owner-roster.mjs
node --experimental-strip-types --experimental-vm-modules --test examples/compute/staging-acceptance.test.mjs
pnpm --filter @waldo/runtime exec tsc --noEmit --project tsconfig.compute-example.json
pnpm --filter @waldo/runtime exec vitest run --config vitest.compute.config.ts
pnpm --filter @waldo/runtime exec vitest run test/owner-do-registered-workspace.test.ts -t compute
```

Run official Wrangler deploy --dry-run --config wrangler.staging.jsonc from examples/compute to build locally; dry-run is not image publication/deployment. Deployment requires the specific resource/spend clearance below.

## Spend/access clearance, without invented blockers

Exact proposed hosted scope: existing-account managed image build/publication, private Worker+SQLiteDO+Container application, one staging runtime binding, one verified owner, **one**30s synthetic executable operation, same-operation recover/replay, and prompt cleanup. Use existing authorized deployment identity with workers_scripts:write, containers:write and managed registry/artifacts write; no new persistent credential/session or owner grant. Prior read-only inspection found those permissions, but current operator preflight is required. Do not extract tokens or router secrets to fabricate invocation access. Existing owner route and service binding are the call path.

Containers require Workers Paid. Verify current account is already eligible; no subscription approval is necessary if already Paid. A new Paid subscription/recurring charge needs explicit clearance only if an upgrade is actually required. Current official pricing rechecked: marginal lite resource35s estimate$0.000070525;935s conservative resource estimate$0.001884025. These are estimates, not billing ceilings; startup/alarm delays, Workers/DO/registry/R2/render/channel and subscription costs are separate. Dynamic policy does not support max_instances and no enforceable account dollar cap is claimed. Existing shared20 test budget is sufficient budget context when the parent's specific new provider deployment/one-operation clearance covers it; do not ask for a second budget or broaden permission to a fleet. No provider spend is authorized merely by publishing source.

Native limits: lite1/16vCPU,256MiB,2GB;Internet off;no env/credential injection;inputs/output256KiB;logs16KiB;30s deadline;wholeVMdestroy on terminal paths;durable35s alarm and finite PID1 as interruption guards. One operation/owner and serial observation bound acceptance, not global account usage. Reference: https://developers.cloudflare.com/containers/platform/pricing/ and https://developers.cloudflare.com/containers/configuration/scheduling-policy/ .

## One practical hosted acceptance, after soak/release clearance

1. Pin approved current-beta PR906 source and clean build; retain prior runtime/provider deployment IDs as rollback. Independently verify current target/account/version/bindings and existing auth; no schema/SQL/security/secret modification. Deploy native private provider/image and add only COMPUTE binding under the operator's separate activation authority.
2. Through the real authenticated owner channel save exported STAGING_CSV from staging-acceptance.ts via workspace_write (or upload exact CSV through existing authenticated console route). This is synthetic item/quantity/price data, not third-party content or messages.
3. Use stagingWorkspaceComputeRequest(returnedFileId,exactRevision,newDestination) with existing workspace_compute. Fixed Node argv parses quoted Desk,oak data, reports$229.50, checks realLinux/PATH-only env and one TCP denial. No network success or inconclusive timeout is accepted; configured Internet=false remains the actual boundary. Keep actual tool-call/operation identity and native stdout privately.
4. workspace_read exact result must equal STAGING_REPORT. workspace_render makes real PDF/DOCX; deliver using current owner channel receipt. Authenticated download200/validbytes and anonymous401; retain hashes and %PDF- or validDOCX. This is user-visible delivery proof, not merely handler success.
5. Reopen after ownerDO recreation/interruption. Existing owner effect unknown reconciles the same provider/workspace receipt without dispatch fallback. Compare same operation/file/revision/bytes/native nonce. Never create a replacement identity and call it recovery. Issued-but-unconfirmed stays visibly uncertain; any additional execution needs separately counted operation clearance. Local tests cover response loss and /stop cancel/late publication denial; adversarial cross-owner provider tests deny before allocation without issuing another owner's code.
6. Remove optional binding, reset private roster deny-all and verify stopped container/resource/usage; preserve owner artifacts/receipts. Undo no unrelated browser or current runtime changes and delete no owner workspace/custody.

Optional stagingProviderAcceptance(service,ownerScope,runId) is a runnable helper for the existing private ComputeService binding: unused-ID preflight,execute,exactreport/Linux/env/network checks,recover,completedreplay/samenonce,cancel finally. It adds no route/RPC. It proves provider receipt only; normal owner journey above is preferred for full outcome. Choose either helper or owner execution for the one-operation allowance; never run both automatically.

Parent summary contains source/runtime/provider versions and digests, private target association verifiedyes/no, operation count1, Linux/env/network/report/render/private delivery/reopen/cleanup results and actual usage. Actual owner/account/provider/operation IDs and credentials remain operator-private; no transfer needed. Hosted outcome remains unverified until those receipts exist. No Gmail/Calendar effect, arbitrary third-party message, new grant, paid activation, public source retry for Google or deployment during soak is requested here.
