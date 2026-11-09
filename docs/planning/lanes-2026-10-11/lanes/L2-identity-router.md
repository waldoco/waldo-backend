# L2: owner identity and delivery router

**Owner:** the existing session "Find why event-route Telegram sends are blocked on staging", already inside this code with #1034. Repo: `waldoco/waldo-backend`, base `beta-mvp`.

## Owner rulings this lane implements (11 Oct)

Also posted on #1034, comment 6106243246.

1. **Proactive delivery goes to the owner's chosen surface; otherwise to the app.**
   - This applies to Telegram-linked owners too, until a "deliver to" setting exists. L3 builds that setting.
2. **One main conversation per owner** across app, console, Telegram, WhatsApp and iMessage. Threads stay app and console only.
3. **No account or Durable Object is renamed.**
   - The account is already the root: `auth.users` → `waldo.owners.id` → `do_name`.
   - What is Telegram-shaped is the owner principal inside the DO.

## Slices, in order

The source citations are in [`../IDENTITY_ROOT_PLAN.md`](../IDENTITY_ROOT_PLAN.md) §1 and §3.

0. **#1034.** Change its routing to ruling 1 before it merges.
1. **Owner principal.** The owner is `owners.id`; `setup(surface)` takes the surface separately.
2. **Delivery.**
   - Surface-aware final records (an additive `surface` field).
   - The router.
   - A real app acknowledgement, replacing the fake `message_id`.
   - Connect, reconnect and "connected" notices routed per surface.
3. **Every scheduled job runs for every owner, through the router:** Brief, Close, heartbeat, nightly, standing orders, Calendar Prep. Skills and ratings move to owner level.
4. **One main conversation:** merge today's `owner:prn_<id>` and `telegram-<chat id>` histories once, with a dual-read and a window test.
5. **Custody re-key.** Browser and task custody on `owners.id`, with a dual-read period. Browser admission without a Telegram link. This unblocks browser errands from the app.
6. **Surfaces.** `/event`, WhatsApp and iMessage resolve the owner through the directory; add the `imessage` presence provider. This is the seam Ashish plugs into.
7. **Clean-up.** Retire the `deployOwner` fallback and the legacy console route; settle what `RunLoopDO` owns.

Then **S7 (APNs push)**, so app deliveries notify.

## Rules

- **Never emit a Telegram-addressed delivery for an app-only owner** before slice 2 lands.
- **Changes to app.v1 are additive only.** Tell L4 (the app) before shipping a new part or value. L3 edits `packages/contracts/src/app/*`.
- **You are the primary owner of `channels/telegram-owner-do.ts`.** L1's H5 and L3's piece A touch it too: either make their DO-side edits on request, or they announce first and whoever merges second rebases.
- **Check first:** `telegram-owner-do.ts:601-602` writes `do_name` from a header. The review found no `idFromName` check beside it (unverified).
- **Per-action owner go** for merges and deploys. L1 is the staging deployer once #1034 is merged.

## Exit (your part of Phase 1)

An app-only owner, on a physical iPhone:
- gets a Brief and a reminder in the app with a push;
- says something on one surface, and the other surface sees it in the same conversation.
