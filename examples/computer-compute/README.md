# Computer 0.5.0 compute trial

The fixed local acceptance journey passes against the real official Computer 0.5.0 Linux daemon: synthetic CSV produces a $229.50 Markdown report, stdout is `linux`, exit is zero, and the pulled report reopens from real workerd SQLite without rerunning the command. The test passed in 1.22 seconds; Docker container absence was verified after cleanup. See `evidence.json` and `packages/runtime/test/computer-daemon.test.ts`.

This isolated, nondefault source proposal replaces only the Linux execution backend. It retains owner compute RPC, owner/operation identity, durable journal, recover and cancel semantics. No OwnerDO routing or default provider configuration changes. Existing owner workspace authority, R2 compare-and-swap receipts, renderer and private channel delivery remain above this interface.

The package is pinned to `@cloudflare/computer@0.5.0`, with official daemon release digest `sha256:eb942ccd44cc259d68ece8fbdf59795d4451c893592d5ea1d8e0fd5cb963d547`. `ComputerContainerExecutor` copies selected revision bytes into a task-owned SQLite Workspace, runs quoted argv through the configured backend, requires complete pull with no skipped files, rejects symlink output ancestors and reads only the declared output.

The adapter bounds 32 input files, 256 KiB total input, 256 KiB exported file, 64 argv entries, 30 seconds and 16 KiB combined diagnostics. Native ContainerBackend configuration disables network egress and retries. No owner credentials are injected; the SDK creates an internal daemon RPC transport capability. Native container destruction, a persistent 35-second DO alarm and an image timeout provide teardown. Workspace.close is not VM destruction. Startup is fenced before and after awaiting launch; recover reads the durable receipt and never issues another command.

SDK output retention, daemon replay buffers, scratch growth and full filesystem sync are not adapter-bounded. These are general resource-management gaps for arbitrary/adversarial commands. They did not prevent the fixed small acceptance test, and solving every quota is not a prerequisite to demonstrating the official daemon. The passing synthetic journey does not prove general quotas; default adoption requires measured resource bounds.

## Proof layers

- Actual: official pinned image built locally; Linux computerd selected its userspace shim; released Workspace/TestBackend executed CSV-to-report, pulled and bounded-read the report, then reopened real workerd SQLite storage. One real-daemon test passed. The daemon's own transient memory store is separate from the durable Workspace SQLite file store tested by reopening.
- Actual local cleanup: shell removed the Docker container and checked absence with docker ps. No host directories were mounted, no secrets forwarded, and the published listener was loopback only. Docker used 512 MiB memory, one CPU and 128 process limits.
- Contract tests: 10 adapter tests passed, including cancellation, skipped/incomplete sync, log/file bounds and symlink rejection. Existing compute regression tests passed 35/35. Worker, integration and standalone example typechecks passed.
- Still unverified: native Cloudflare ContainerBackend/provider lifecycle, native egress controls, live owner R2/channel delivery, and PDF rendering on this Computer-backed journey. The local daemon fixture counts native destroy through a labelled double; Docker cleanup is verified separately. No deployment, provider calls/spend, access grants, secret changes, image publication or default activation occurred. PR973 is unchanged.

## Reproduce locally

From the repository root, with local Docker Desktop access approved:

```sh
bash examples/computer-compute/local-daemon-proof.sh
```

The helper builds the pinned images, starts a loopback-only daemon, requires a successful health probe, invokes the fixed fixture and always removes/checks the container. Its image-level 35-second watchdog applies to the daemon. The local TestBackend fixture uses no daemon RPC secret and must never be exposed publicly.

Alternatively, while a loopback daemon is alive, from packages/runtime:

```sh
COMPUTERD_HARNESS_URL=http://127.0.0.1:8080 pnpm exec vitest run --config vitest.computer-daemon.config.ts
pnpm exec tsc --noEmit -p tsconfig.computer-compute-example.json
pnpm exec vitest run --config vitest.computer-compute.config.ts
```

The URL is required; missing URL fails instead of silently skipping. The fixture compatibility date is `2026-07-02`, supported by the pinned local workerd. The initial `2026-10-07` date failed runtime startup before tests; only the local test fixture date was corrected. Production proposal configuration was not changed.

## Approval history and review

The original blocked action was `docker build --platform linux/amd64 -t waldo-computer-trial:local examples/computer-compute`. Two escalated requests hit automatic approval-review deadlines, with no stated safety rejection reason. A sandboxed invocation then reported Docker socket permission denied. No sandbox retry or bypass followed. Later normal scoped approval allowed local build/test/cleanup; the first runtime attempt exposed the fixture date mismatch, and approved continuation passed after correction.

The approved scope was local Docker Desktop socket access, official GHCR/Docker Hub downloads, local image/cache writes and the fixed synthetic test. Docker is a privileged host interface; the helper requests no host mounts, secret forwarding, public listener, image push, deployment or Cloudflare execution.

Independent source review at `3930c45b3778e23e95aa8c75c728227c0b3182e8` found no additional source blockers within scope and independently passed all 10 adapter tests. Its verdict was trial-only with the documented general resource gap. The execution adapter and native worker remain unchanged; this checkpoint corrects only the local fixture date and adds reproducible proof/evidence.

Independent review of the five-file proof/helper delta at `7e6eeb18b8b8a7daab407e9f4b6402f14e4c8f94` passed with no blocking findings. The reviewer checked cleanup and proof boundaries without rerunning Docker. This final evidence checkpoint changes only documentation.
