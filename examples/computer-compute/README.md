# Computer 0.5.0 compute trial

This isolated, nondefault source proposal replaces only the Linux execution backend. It retains the existing owner compute RPC, owner/operation identity claim, durable journal, recover and cancel semantics. No OwnerDO routing or default provider configuration changes. Core must review integration separately.

The implementation pins `@cloudflare/computer` to 0.5.0 and the official released daemon image to a registry digest. `ComputerContainerExecutor` copies only selected revision bytes into a task-owned SQLite Workspace, runs quoted argv on ContainerBackend, requires complete pull with no skipped files, rejects symlink output ancestors, and reads only the declared output. Existing workspace authority, R2 compare-and-swap receipts, renderer and private channel delivery remain above this interface.

Limits enforced at the adapter: 32 input files, 256 KiB total input, 256 KiB maximum exported file, 64 argv entries, 30 seconds, 16 KiB combined diagnostic output. Network egress is disabled and restart attempts are zero. There is no automatic owner credential injection. The SDK creates its own daemon RPC transport capability; that capability is internal service authentication, not an owner credential.

These limits are not a provider-wide quota guarantee. SDK output:false still retains internal output; streaming and result() are mutually exclusive. Full filesystem sync, daemon replay buffers and scratch growth are not adapter-bounded. A malicious command can exhaust those internal resources before the stream limiter reacts. These are general resource-management gaps for arbitrary or adversarial commands; they do not prevent attempting the small, fixed synthetic CSV acceptance journey with the official daemon. The journey writes one short report and a small diagnostic line. Demonstrating that journey does not require solving every quota first, and passing it would not establish general quota enforcement. Default adoption still needs measured resource bounds.

Native container destruction, a persistent 35-second DO alarm and an image timeout provide independent teardown. Workspace.close does not destroy the VM. Start/restart are fenced before and after awaiting startup to kill late starts after cancellation. Recover reads the existing durable operation receipt and never opens Workspace or issues another command. Unknown interrupted commands remain pending rather than replaying.

Run from packages/runtime:

```
pnpm exec tsc --noEmit -p tsconfig.computer-compute-example.json
pnpm exec vitest run --config vitest.computer-compute.config.ts
```

Evidence so far: released package installed from the official npm registry; daemon manifest digest resolved from official GHCR; standalone example TypeScript compilation passes; 10 adapter contract tests pass using labelled Workspace/transport doubles. Actual daemon journey and hosted native Container lifecycle remain unverified. No deployment, provider execution, access grant, secret change or Cloudflare spend has occurred. A local Docker image build is a separate proof layer and must not be described as hosted Container proof. Both escalated build attempts stopped at automatic approval-review deadlines; a sandboxed attempt failed with Docker socket permission denied. No image was built or command executed. Runtime worker and integration TypeScript checks also pass.

The actual-daemon fixture lives in `packages/runtime/test/computer-daemon.test.ts`. It uses released Workspace/TestBackend and real workerd SQLite; its Docker lifecycle remains an explicit fixture, and it does not prove native provider authentication, egress controls, PDF rendering or channel delivery. Worker TypeScript covers the fixture; the missing-URL configuration guard was observed to fail as expected. Execution still requires a local daemon.

Build the image from the repository root with `docker build --platform linux/amd64 -t waldo-computer-trial:local examples/computer-compute`. Start it with a loopback-only published port, for example `docker run --rm --platform linux/amd64 -p 127.0.0.1:8080:8080 waldo-computer-trial:local`, and while it is alive run from packages/runtime:

```
COMPUTERD_HARNESS_URL=http://127.0.0.1:8080 pnpm exec vitest run --config vitest.computer-daemon.config.ts
```

The image's 35-second watchdog applies to the daemon. The shell operator must remove the local container after testing. The TestBackend fixture uses no daemon RPC secret and is restricted to loopback; it must never be exposed publicly.

Independent source review completed at `3930c45b3778e23e95aa8c75c728227c0b3182e8`, with 10 adapter tests independently passing and no additional source blockers within scope. The existing compute regression suite also passed all 35 tests. Review concluded trial-only, with the documented resource-management gap. This later checkpoint changes documentation and evidence only.

Docker blocker details: the exact action was `docker build --platform linux/amd64 -t waldo-computer-trial:local examples/computer-compute` from this worktree. Both `require_escalated` requests returned “The automatic permission approval review did not finish before its deadline.” This is a review timeout, with no stated safety rejection reason. The sandboxed invocation returned “permission denied while trying to connect to the docker API at unix:///Users/shivanshfulper/.docker/run/docker.sock”. That is a filesystem/socket denial. No Docker retry or alternate access path followed that denial.

Required scope for that blocked action is local Docker Desktop daemon/socket access plus official GHCR and Docker Hub image downloads to build one local image. Expected effects are image/cache disk writes and local CPU/network use. Docker daemon access is a privileged host interface, so approval should be limited to the specific local build/test actions, with no host directory mounts, credential forwarding, public listener, image push, deployment, or Cloudflare execution. The synthetic daemon acceptance test is a later separate local action; it should bind only loopback and clean up its container.
