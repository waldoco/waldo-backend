# Native owner login/MFA handoff — fresh implementation

Base: a56797a3e9d19ad1a64c63b5e974f22bb2f9f521. This work does not reconstruct the lost cloud candidate or inherit its receipts.

An ordinary retained Cloudflare task asks for owner login/MFA, persists pending handoff metadata in the existing browser task, ends the model turn with a non-secret authenticated console URL, and blocks all agent DOM/action/image access. Console GET never mints a provider URL. An authenticated, same-origin, CSRF-checked, bounded/rate-limited POST opens native tab Live View after exact owner/task/custody checks before and after provider work. Bearer material is only in escaped no-store/no-referrer iframe HTML, never model/chat/state/logs.

Subscribe before handoff; correlate provider session, target and handoff ID. No absent/contradictory completion can resume. After the final custody await, consume matching completion synchronously once, invalidate old refs, and observe fresh evidence on a later authenticated owner turn. Require intended-account verification; provider Done is not account verification. Preserve the funded session lifetime. Cancellation, expiry, revocation and reconstruction terminate the exact session with absence confirmation; no authentication replacement or profile export.

Fresh regression requirements: maintenance preserves valid starting/resuming transitions, including changes during awaited status; final completion consumption is atomic after custody and cannot race a contradictory event. Cover inbox/tool/console/completion/next turn with labelled provider/model doubles, unauthorized owner, preview GET, CSRF/origin/rate limit, expiry/revocation, duplicate resume/conflicting events/restart/cleanup. Preserve public and retained regressions. Local native probe uses fictional credentials, localhost POST/303/cookies and disposable profile; Cloudflare protocol/UI remains doubled.

Pinned installed SDK 1.3.6 declarations expose Cloudflare.handoff, handoffComplete, getHandoffState, getSessionId and getLiveView(mode:tab). Handoff maximum is 30 minutes, bounded here by already-funded expiry. Live View connection-start expiry is up to one hour, not a limit on connected viewers. Done does not document disconnection; exact session termination is strong revocation.

Official references consulted 2026-10-09:
- https://developers.cloudflare.com/browser-run/features/human-in-the-loop/
- https://developers.cloudflare.com/browser-run/features/live-view/

No live provider/model/account proof, deployment, new credentials/grants, migrations/reset, or production authorization follows from fake/native tests.
