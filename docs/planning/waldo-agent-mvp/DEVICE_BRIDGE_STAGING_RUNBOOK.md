# Device bridge staging trace: owner-go runbook

Status: **not run.** No staging trace has run. This runbook describes how the owner (Ashish) runs it once, by choice, and what a pass does and does not show.

Scope: contract **v0.2.3 only**, with capabilities `machine_state_query` and `notify_local`. Anything about v0.3, `use_mac` or new capabilities is out of scope.

Out of scope for this trace: **#928 (iMessage host connector)**. Its tests use fixtures only, and nobody has confirmed whether it is deployed. The trace never touches it, and a PASS says nothing about it.

## What the trace is

`packages/runtime/scripts/device-bridge-staging-trace.mjs` plays a Mac device in software. It uses the owner's own console session against the staging Worker. The steps, in order:

1. Pair one device and redeem the code with a signed request.
2. Connect over WebSocket with a signed request and send heartbeats.
3. Run a `machine_state_query` round trip.
4. Open a second connection and check that it replaces the first.
5. Disconnect, queue a `notify_local`, reconnect and reconcile.
6. Check the idempotency conflict.
7. Revoke the device, then check that a reconnect after revoke is rejected.

The whole step list lives in `device-bridge-staging-plan.mjs`. `--dry-run` prints that list. A real run fails if it strays from the list.

That same flow runs locally against an isolated wrangler with a fake RPC stub:

```bash
node packages/runtime/scripts/device-bridge-staging-trace-local.mjs
```

The local run must PASS on the same checkout, on the same day, before any staging run.

## Preconditions

Each item needs to be confirmed from evidence. Word of mouth doesn't count.

- [ ] **The release contains the bridge.** Dalda reads the `release` in staging `/healthz` and resolves it to a commit. `git merge-base --is-ancestor <bridge merge> <release sha>` must succeed for the bridge merges (#975, #976; see the PR's SHA table). A release id label alone does not count.
- [ ] **The migration is applied.** Dalda reads the staging migration history (output of `scripts/staging-migration-preflight.mjs`, or the apply route's record). It must list version `20261008000100` (`20261008000100_waldo_device_bridge.sql`) as applied, read from the ledger. A deploy message does not count.
- [ ] **The local proof passes.** `device-bridge-staging-trace-local.mjs` printed `PASS` from this checkout today. The guard tests pass too: `pnpm --filter @waldo/runtime exec vitest run test/device-bridge-staging-trace-guard.test.ts`.
- [ ] **The checkout is clean.** It is at the reviewed commit. Node ≥ 22, and `pnpm install --frozen-lockfile` has been run.
- [ ] **No other trace device is present.** No leftover `Staging Trace Device` appears on staging `/console/devices`.
- [ ] **Ashish has given an explicit go** for this one run, in his own words. A go does not carry over to another run, retry or host.

## Supplying the console cookie (owner only, at run time)

The cookie is the owner's console session. It must never appear in chat, the repo, a PR or issue, a ticket, a log, a screenshot or shell history.

1. Open a fresh **private** browser window and sign in to the staging console as the owner.
2. Open DevTools, then Application → Cookies → the staging origin. Copy the values of `waldo_owner` and `waldo_console`. Both are `HttpOnly`, so page scripts cannot read them.
3. In the terminal that will run the trace, read the cookie without echoing it and without writing it to history:

   ```bash
   read -rs WALDO_CONSOLE_COOKIE
   ```

   Paste `waldo_owner=<value>; waldo_console=<value>` and press Return. Then:

   ```bash
   export WALDO_CONSOLE_COOKIE
   ```

4. After the run, sign out in the console. `session.signout` ends the session on the server. Then close the private window and clear the variable:

   ```bash
   unset WALDO_CONSOLE_COOKIE
   ```

   If you skip the sign-out, the console session cookie stays valid for up to 12 hours (`Max-Age=43200`).

## Command

`WALDO_STAGING_ALLOWED_HOSTS` is a comma-separated list of exact lowercase hostnames. Add `:port` only for a port other than the default. The guard accepts `WALDO_STAGING_URL` only when its normalised host matches an entry exactly. It refuses:

- substring, suffix and wildcard matches
- `http`
- URLs with credentials in them
- IP literals and `localhost`
- trailing dots and `xn--` labels
- any path, query or fragment
- a cookie that spans more than one line

```bash
export WALDO_STAGING_URL=https://<exact staging host>
export WALDO_STAGING_ALLOWED_HOSTS=<exact staging host>
```

Do the dry run first. It makes no network call. It prints the target origin and every effect, so you can confirm both are right:

```bash
node packages/runtime/scripts/device-bridge-staging-trace.mjs --dry-run
```

Then the real run. Do it only with the go:

```bash
node packages/runtime/scripts/device-bridge-staging-trace.mjs
```

Exit code 0 means PASS. Exit code 1 means the run was REFUSED by the guard or argument checks (no request was sent) or it FAILED (see Cleanup).

## Expected output

Values shown in `<…>` change from run to run. The trace never prints the cookie, the CSRF token, the pairing code or the device key.

```
STAGING: healthz <body, at most 200 chars>
STAGING: unsigned redeem rejected with the exact generic 401
STAGING: pair code issued (value not printed)
STAGING: signed malformed redeem rejected with the exact generic 401
STAGING: foreign-signed redeem rejected with the exact generic 401
STAGING: signed redeem 200 for device <device_id> (code survived the foreign-signed attempt)
STAGING: used-code replay rejected with the exact generic 401
STAGING: signed socket 101
STAGING: heartbeat accepted; console shows the trace device online
STAGING: query -> command -> ack -> answered -> receipt
STAGING: second connect 101; first socket closed 1008 with no frame; replacement heartbeat shows online
STAGING: device closed normally (1000); console shows offline
STAGING: owner device.notify (neutral preset) accepted while offline
STAGING: reconnect 101; nothing delivered before a heartbeat
STAGING: heartbeat -> only the queued notify_local -> ack -> delivered -> receipt; reconciled heartbeat re-delivers nothing
STAGING: reused message_id with an altered body closed 1008 with no frame
STAGING: connect 101 + heartbeat online; console history shows query answered (unknown) and notify delivered
STAGING: owner revoke accepted
STAGING: socket closed 1008 after revoke
STAGING: revoked reconnect rejected with the exact generic 401
STAGING: PASS device-bridge trace; real Kennel client, Mac keychain, sleep/wake and OS notifications UNVERIFIED
```

## What one run changes on staging

- **Pairing code:** one single-use code. It expires after 10 minutes.
- **Test device:** one device labelled `Staging Trace Device`. It is revoked at the end, and its Durable Object storage is deleted once the clock-skew window has passed.
- **Commands:** one `machine_state_query` command, answered `unknown` by the simulated device. One `notify_local` command with the fixed neutral preset "Waldo status" / "Your Mac is connected.". No real Mac receives anything.
- **Redeem throttle:** three counted redeem attempts (foreign-signed, real, replay). The malformed and unsigned attempts fail before the throttle. The limits are 5 per minute and 20 per hour per IP, and 5 per code per 10 minutes. Wait at least a minute between runs, and run no more than about 6 times an hour.

## Cleanup check

- On PASS, the test device is already revoked. Reload staging `/console/devices` and confirm that `Staging Trace Device` is **not** listed.
- On FAIL after the redeem step, the trace tries a cleanup revoke. It prints `STAGING: cleanup revoked test device`, or a line telling you to revoke `Staging Trace Device` by hand on `/console/devices`. Do that, then reload and confirm it is gone.
- On FAIL before the redeem step, no device exists. An unused pairing code may remain. It is single use and expires within 10 minutes, so there is nothing to revoke.
- After any run, sign out of the console (see above).
- After a FAIL, do **not** retry in a loop. Copy only the `STAGING:` lines (they contain no secrets) and report them. Each retry needs a fresh go.

## What a PASS proves

- The deployed staging Worker serves the v0.2.3 bridge from pair through revoke, with signed redeem and connect.
- Pre-auth rejections are the exact generic 401 bytes, including for:
  - a malformed body
  - a body signed with a foreign key
  - a replayed code
  - a reconnect after revoke
- A rejected redeem does not consume the code.
- Replacing a socket closes the old one with 1008.
- A normal disconnect shows as offline.
- Work queued while offline is held until a reconnect heartbeat reconciles it, and is delivered exactly once. An already-receipted command is not sent again.
- A reused `message_id` with an altered body is refused with 1008.
- Revoke closes the live socket with 1008 and blocks any later connect.
- The console shows status and history for this device's own row.

## What a PASS does not prove

- That a real Kennel client can pair, store its Ed25519 key in the Mac keychain, or survive sleep/wake and network changes.
- That a real `notify_local` OS notification appears.
- That receipts are proof the work was applied. They are not.
- Behaviour under real latency, load or a Worker redeploy in the middle of a session.
- Anything about #928 / iMessage, v0.3, `use_mac`, or production. Production is never targeted.

## Owner-go checklist (tick in this order)

1. [ ] Every precondition above has been confirmed, with the evidence linked.
2. [ ] The dry run printed the expected exact origin and the 20 planned effects.
3. [ ] Ashish said "go" for this run.
4. [ ] The real run finished, and its exit code and `STAGING:` lines were captured.
5. [ ] Cleanup check passed, and the owner signed out with `WALDO_CONSOLE_COOKIE` unset.
6. [ ] The result was recorded (date, release sha, PASS/FAIL, `STAGING:` lines), with no cookie, CSRF token, code or key in it.

## Required follow-up: real-client run

After a staging PASS, the next proof is the real Kennel client. It needs its own separate owner go. The client side is Kennel #236 (inactive activation package) and Kennel #243 (Connect-to-Waldo Slice B). Both are off by default. The run must show:

1. The owner mints a code in the staging console, and Kennel redeems it after the owner pastes the code in.
2. The device key is generated on the Mac and stays in the keychain. Only the public key leaves the machine.
3. The connection comes up, heartbeats arrive, and the console shows the device online.
4. Sleep/wake (and a network change) produces a reconnect. Pending work is reconciled before any new delivery.
5. `notify_local` with a neutral preset shows a real macOS notification.
6. A console revoke closes the connection, and Kennel cannot reconnect with the revoked key.

Until that run passes, treat the real client, keychain, sleep/wake and OS notification paths as **UNVERIFIED**.
