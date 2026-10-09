# Computer 0.5.0 compute trial

This isolated, nondefault source proposal replaces only the Linux execution backend. It retains the existing owner compute RPC, owner/operation identity claim, durable journal, recover and cancel semantics. No OwnerDO routing or default provider configuration changes. Core must review integration separately.

The implementation pins `@cloudflare/computer` to 0.5.0 and the official released daemon image to a registry digest. `ComputerContainerExecutor` copies only selected revision bytes into a task-owned SQLite Workspace, runs quoted argv on ContainerBackend, requires complete pull with no skipped files, rejects symlink output ancestors, and reads only the declared output. Existing workspace authority, R2 compare-and-swap receipts, renderer and private channel delivery remain above this interface.

Limits enforced at the adapter: 32 input files, 256 KiB total input, 256 KiB maximum exported file, 64 argv entries, 30 seconds, 16 KiB combined diagnostic output. Network egress is disabled and restart attempts are zero. There is no automatic owner credential injection. The SDK creates its own daemon RPC transport capability; that capability is internal service authentication, not an owner credential.

These limits are not a provider-wide quota guarantee. SDK output:false still retains internal output; streaming and result() are mutually exclusive. Full filesystem sync, daemon replay buffers and scratch growth are not adapter-bounded. A malicious command can exhaust those internal resources before the stream limiter reacts. This trial requires a measured quota solution before default adoption.

Native container destruction, a persistent 35-second DO alarm and an image timeout provide independent teardown. Workspace.close does not destroy the VM. Start/restart are fenced before and after awaiting startup to kill late starts after cancellation. Recover reads the existing durable operation receipt and never opens Workspace or issues another command. Unknown interrupted commands remain pending rather than replaying.

Run from packages/runtime:

```
pnpm exec tsc --noEmit -p tsconfig.computer-compute-example.json
pnpm exec vitest run --config vitest.computer-compute.config.ts
```

Evidence so far: released package installed from the official npm registry; daemon manifest digest resolved from official GHCR; standalone example TypeScript compilation passes; 10 adapter contract tests pass using labelled Workspace/transport doubles. Actual daemon journey and hosted native Container lifecycle remain unverified. No deployment, provider execution, access grant, secret change or Cloudflare spend has occurred. A local Docker image build is a separate proof layer and must not be described as hosted Container proof. Both escalated build attempts stopped at automatic approval-review deadlines; a sandboxed attempt failed with Docker socket permission denied. No image was built or command executed. Runtime worker and integration TypeScript checks also pass.
