# Staging probe suite - runbook

Runs synthetic, content-free probes against the waldo-runtime-staging worker and checks
that the receipts match expectations. No private data is used or printed: every payload is
a labelled synthetic string, and the suite prints only status codes, trace IDs, and
pass/fail verdicts.

## Prerequisites (Mac lane)

```bash
export WALDO_PROBE_TOKEN='<the probe token from your vault entry>'
export WALDO_PROBE_URL='https://waldo-runtime-staging.piyushfulper3210.workers.dev'   # optional; this is the default
```

The token lives ONLY in the vault and in the worker's secret store. Never commit it,
echo it, or paste it into the repo.

## Run

```bash
node scripts/probe-staging.mjs            # core suite: auth + payload + capture checks
node scripts/probe-staging.mjs --burst    # adds 22 rapid probes to verify the 20/min rate limiter returns 429
node scripts/probe-staging.mjs --live     # adds ONE real Telegram send to the owner chat (requires --burst too if you want both)
```

## Cases and expected receipts

| # | Case | Request | Expected receipt | Pass criteria |
|---|------|---------|------------------|---------------|
| 1 | auth.missing | POST /probe/turn, no token header | HTTP 403 | status == 403 |
| 2 | auth.wrong-token | POST /probe/turn, wrong token | HTTP 403 | status == 403 |
| 3 | payload.malformed | non-JSON body | HTTP 400 | status == 400 |
| 4 | payload.blank | blank synthetic message | HTTP 400 | status == 400 |
| 5 | payload.oversized | >4KB synthetic message | HTTP 400 | status == 400 |
| 6 | capture.happy-path | synthetic message "SYNTHETIC-PROBE hello" | HTTP 200, JSON body | body.trace matches /^tg-/, body.captured is an array |
| 7 | capture.memory-confinement | probe A plants codeword UVX-7749; probe B asks for recall | HTTP 200 x2 | codeword UVX-7749 does NOT appear anywhere in probe B's response body |
| 8 | burst (--burst) | 22 probes in rapid succession | at least one HTTP 429 | count(429) >= 1 |
| 9 | live (--live) | one synthetic message routed through the real Telegram send path | HTTP 200 | body.captured == null (nothing captured on the live path) |

## Pass / fail

The suite exits 0 when every selected case passes, 1 otherwise. Each case prints one line:
`PASS|FAIL  <case>  <status>  <detail>` where detail is a status code or receipt shape,
never payload content.

## What a failure means

- Case 1-2 fail: the probe endpoint is reachable without auth. STOP - report immediately.
- Case 7 fails: codeword leaked across turns - memory confinement broken. STOP - report immediately.
- Case 3-5 fail: payload validation regressed.
- Case 6 fails: happy path broken (check the trace ID against the worker logs).
- Case 8 fails: rate limiter not enforcing 20/min.
- Case 9 fails: live Telegram path broken (captured should be null, status 200).
