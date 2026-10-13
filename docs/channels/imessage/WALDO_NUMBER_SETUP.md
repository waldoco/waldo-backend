# Waldo's own iMessage line: setup and first live trace

Waldo gets its own Apple Account, made with the Waldo email and the new phone number. People text that
address or number from their iPhone, and the message reaches their own Waldo. This page covers the
physical setup and the order of the software work. It authorizes no deployment, hosted migration or
real credential use.

## What is true today

| Piece | State |
| --- | --- |
| Backend connector (pairing, bridge Durable Object, owner channel, signed outbox) | Built behind `IMESSAGE_CONNECTOR_ENABLED=0`. Proven against a simulated host only. See the [runbook](IMESSAGE_CONNECTOR_RUNBOOK.md). |
| Mac host (`waldoco/waldo-imessage-host`) | Fixtures only. It has no live Messages database mode, no HTTPS transport to the backend, no command pull and result loop, and no live AppleScript send. |
| Apple Account, host Mac, Waldo's number on iMessage | Not set up. |

Nothing goes live until the host's live mode exists. The host is the critical path, not the backend.

## Physical setup (can start now, in parallel with code)

Each step ends with a check you can see. A step whose check fails is the answer: stop and report it.

1. **Apple Account.** Create it with the Waldo email. Use the new number for its two-factor
   verification; the code arrives by SMS on the OnePlus.
   *Check:* you can sign in at account.apple.com.
2. **Host machine.** Use the Intel iMac as the host from the start.
   - Note its macOS version (Apple menu, About This Mac). The host's reading of the Messages database is
     unverified on any real macOS, so the version matters.
   - Create a dedicated macOS user for Waldo and keep it the logged-in user. Never run the host in a
     personal account: it reads that user's whole Messages history and forwards every direct iMessage.
   - Turn off sleep for that user and keep the iMac on power and network.
3. **iMessage on the email.** In that macOS user, open Messages and sign in with the Waldo Apple Account.
   *Check:* Messages, Settings, iMessage lists the Waldo email under "You can be reached at".
   *Falsifier:* send an iMessage to the Waldo email from your own Apple device. It must arrive in blue on
   the iMac. If it arrives as nothing, or the account will not activate, a new Apple Account may need
   time or a support contact before iMessage works.
4. **Test sender.** The first live test needs an iPhone or Mac signed into a different Apple Account
   that texts Waldo. Your OnePlus cannot send iMessage. Your dev Mac's own Messages, on your personal
   Apple Account, is the natural sender.
5. **The number (later, for the phone-number address).** Put the SIM in the spare iPhone SE and sign in
   with the Waldo Apple Account. Turn on iMessage and pick the number under Send and Receive.
   *Check:* on the iMac, Messages settings now list the number as well as the email.
   Keep the iPhone SE on power and network with the SIM active, because Apple re-verifies the number by
   SMS. It must never reply to anyone itself.
6. **Host permissions (when the live host exists).** Grant the host Full Disk Access, for the Messages
   database, and Automation access to Messages, for sending.

**Risk to accept knowingly:** automating Messages on a consumer Apple Account is not an Apple-supported
business route. Apple can restrict an account that sends like a bot. Keep early volume low.

## Software order

1. **Backend on current `beta-mvp`** (this branch). The connector sits on the `OwnerDO` rename: its
   migration is `20261013130000`, its Durable Object takes wrangler tag `v7`, and its suites pass locally.
2. **Host live mode** in `waldoco/waldo-imessage-host`, following the
   [compatibility packet](fixtures/HOST_COMPATIBILITY.md):
   read the real Messages database, redeem the pairing invitation, send signed events and heartbeats
   over HTTPS, poll `/commands/pull`, check the commitment, journal, send with AppleScript, and post one
   terminal result. Confirm who owns that repository before changing it.
3. **First live round trip, one owner.** The existing per-owner pairing already fits one tester:
   - pair Waldo's iMac from the owner console;
   - set the exact sender to the test sender's handle, with chat `iMessage;-;<handle>`;
   - send the challenge from the test sender, then confirm it;
   - text "hi" and see Waldo's reply arrive.
   This needs a Worker with the connector enabled, a reviewed policy, the wrapping key secret and the
   hosted migration. Each of those needs its own go.
4. **Shared line for many users.** Only after step 3 has round-tripped. One Waldo-owned bridge serves
   every user, and each sender links to their owner the way WhatsApp senders do today, with a one-time
   code from the app. The change is to the authority model:
   - the bridge belongs to Waldo (an operator), not to one owner;
   - each owner's binding names the shared bridge and their own sender and chat, which the existing
     binding schema already allows;
   - pairing the bridge becomes an operator action, and per-user linking replaces per-owner pairing.
   Design it from what the first round trip shows, not before.

## Proof limits

Local evidence only: typecheck, unit and Durable Object suites, guards and the simulated-host trace.
A real Apple send, recipient delivery, the iMac's macOS, sleep and wake, hosted SQL and deployment are
unverified.
