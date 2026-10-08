# Fixture-only Mac host cloud connector

This library adds a signed pull mailbox, a text sender through the existing S2
SignedRelay, and a relay-to-owner-turn adapter. It is disabled: there are no HTTP
routes, handler registrations, production composition, host calls, or live credentials.
All acceptance traces use synthetic keys, temporary SQLite databases, the real
SignedRelay, and an injected fake host. The Mac host is unchanged.

## Wire profile v0

Bodies are exact UTF-8 JSON strings. Every request carries S2 headers
`{version:1,bridgeId,accountId,atMs,nonce,signature}`. HMAC-SHA256 signs
`JSON.stringify([version,bridgeId,accountId,atMs,nonce]) + "\n" + body` using the
injected trusted account key. Signature freshness, account scope, strict schemas,
and persisted nonce replay protection precede state changes. HTTP paths and header
names remain undefined.

| Direction | Library handler | Body and response |
| --- | --- | --- |
| Mac to cloud events / heartbeat (a) | Existing SignedRelay.admit / heartbeat | Unchanged S2 |
| Capabilities (b) | mailbox.reportCapabilities(body, headers) | Exact S0 capabilities; returns `{version:1,accepted:true}` |
| Pull (c) | mailbox.pull(body, headers, {waitMs}) | Strict `{version:1,bridgeId,accountId}`; returns `{version:1,delivery:null}` or delivery `{deliveryId,attempt,body,headers}` |
| Result (d) | mailbox.postResult(body, headers) | Strict `{version:1,bridgeId,accountId,deliveryId,commandId,commandDigest,result}`; digest is SHA256 of delivered raw body; returns `{version:1,accepted:true}` |
| Receipt correlation (e) | correlateReceipt(store, event) | Account-scoped messageGuid lookup returns `{commandId:string|null}` without changing the S0 event |

Capabilities remain evidence, with no flag upgrades. Hosts should report at startup
and after capability or generation changes. A missing, stale, or wrong-account
report produces offline disabled capabilities. Relay gates still decide admission.

Pull redelivers the same signed bytes and deliveryId with attempt + 1 until a
terminal result arrives. Only one queued/delivered command exists per bridge/account.
The host must deduplicate command identity plus digest with its own durable journal;
redelivery is not a cloud retry loop. Results must match the delivery, digest,
commandId and exact target. Queued/started results and mismatches are rejected.
An identical terminal repeat is idempotent; fresh repeat nonces are retained.
Different terminal results are rejected and retained as bounded conflict evidence;
the first result stays authoritative. Receipt correlation is populated for S0
local_recorded and delivered results.

## Injected composition and policy

Create a MailboxStore with required `{maxRecords,maxBytes,source}`, then a
CommandMailbox with required `{signatureMaxAgeMs,maxRecords,maxRequestBytes,
pullMaxWaitMs,capabilityMaxAgeMs,source}`, account resolver and clock. Its record
limit must match storage. WAL and synchronous FULL persist deliveries, capabilities,
nonces, sent_messages and an auxiliary result_conflicts table. Every mutation uses
one transaction. Backpressure rolls back without eviction. Expired nonces alone
are pruned according to S2's freshness-window rule. Record and byte accounting
includes all tables, including conflicts.

HostMailboxTransport takes a read-only RelayStore snapshot view, bridge/account,
and required `{deliveryDeadlineMs,relayMutationDeadlineMs,source}`. Delivery deadline
must precede the actual relay mutation deadline supplied by the caller. These values
must come from the same composition; this library cannot inspect the relay's private
policy. Every bound is supplied; there are no production defaults.

buildSendCommand takes an injected binding, caller-stable commandId and nonblank text.
It creates a strict S0 send with attachments [], exact account/chat target, iMessage
service and allowSMSFallback false. signAndExecute signs once and passes an immutable
per-execution signed envelope to the transport via SignedRelay.execute. It adds no
idempotency journal or retry. Group sends, files, formatting, effects, reply targets,
react, edit, unsend, typing and read receive distinct rejected/not_started reasons
before enqueue. This slice exposes functions only; outbound binding resolution is
the caller's responsibility.

If a host never pulls, the transport atomically withdraws only a still-queued delivery
and returns host_not_pulled. If pull wins that race, withdrawal is refused and the
result is uncertain. Result waiting never cuts off before the relay mutation deadline.
The relay's timeout creates unknown/still_in_flight and permanently quarantines the
account lane. Late valid evidence remains stored but cannot clear quarantine. Invalid
posted identity/target results are rejected by the mailbox; relay timeout handles
quarantine rather than accepting malformed results.

local_recorded means **recorded locally on the Mac, not delivered**. Receipt events
are candidate evidence only. The wire accepts the S0 delivered result for matching
and correlation, but the transport refuses to return it as a send claim; the relay
quarantines that execution as transport_result_unavailable. Receipt events never
upgrade a command result.

history is a cloud admission view of retained pending bodies in persisted order,
not native Mac history. Cursors are opaque exact-match tokens. Wrong generation or
unknown cursor throws. Acknowledged bodies are unavailable; only the stream's current
cursor remains usable after its body is removed.

## Inbound seam

createRelayAdmitter has structural dependencies only, with no relay package or Node
imports in Workers runtime. Supply admission authority/directory/media,
onAdmittedTurn, receiptSink, nonTurnSink, and onNotAdmitted. Missing callbacks throw
at construction. The existing admitIMessageOwnerTurn takes a parsed event object;
this adapter passes that object, preserving its authority checks around awaited work.

Only direct incoming iMessage messages can reach an owner turn. Group, SMS/RCS,
echo, unknown sender, revocation and media rejection flow through the required
onNotAdmitted(event, reasonCode) policy. acknowledge drops the event and continues;
hold throws and preserves the queue head and subsequent events. Unexpected adapter,
sink or callback failures also leave the event pending, even when their error text
resembles an admission refusal. Diagnostics contain fixed reason codes only.

Receipt sinks can compose correlateReceipt and label missing commandId as uncorrelated.
All other event kinds go to nonTurnSink and never reach directory or owner-turn admission.
The admission receipt SHA256 covers the original raw body, as required by real relay flush.
Node integration tests for real SignedRelay.flush live in the relay test package;
Workers test pools cannot import node:sqlite. Existing runtime tests remain unchanged.

## Future integration gaps

- **Mac mirror:** wire profile v0 (b) capabilities, (c) pull and (d) result are not
  implemented by the existing Mac slice. Ashish explicitly ordered this cloud-only
  build and left that mirror to a separate future slice. Absence is an integration
  gap, not STOP S6; a conflicting existing mirror would be STOP S6. The Mac host was
  not changed. End-to-end cloud/Mac interoperability remains unverified.
- **G-A hosting:** relay/mailbox require Node SQLite; production runtime is Workers/DO.
  Hosting, HTTP routes and header names are undecided.
- **G-B wire acceptance:** wire v0 needs review and a matching future Mac implementation.
- **G-C lifecycle:** pairing, canonical binding writer, activation/revoke and queued
  command purge rules are undecided. Existing relay post-probe binding checks remain.
- **G-D rejection policy:** drop/hold ownership is undecided; hold blocks the account
  queue head. No default policy is provided.
- **G-E media:** no attachment byte transfer exists; inbound live ticket store/budgets
  and outbound file delivery remain future work.
- **G-F expiry:** delayed host commitment lacks a named age fence. Admission signature
  freshness is not a commitment expiry policy.
- **G-G recovery:** relay has no quarantine-clear or reconciliation API. Late results
  cannot restore a poisoned lane.
- **G-H agent outbox:** final reply/run effect scope and owner-runtime composition are
  not wired; common owner lifecycle work owns that seam.
- **G-I delivery:** delivered/read receipts are candidate evidence without recipient
  device readback.
- **G-J transport enum:** this host uses imsg; a distinct host enum would need S0 changes.

All evidence is local fixture/source evidence, with no staging or live trace. Full
aggregate verify/verify:guards remains unverified locally because the pgTAP bootstrap
requires Linux apt/dpkg; automatic GitHub CI must cover it after draft PR creation.
