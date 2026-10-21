# Memory statement cards and evidence disclosure

Based on #667 tip 6880005149c5c713b43ba5fde01ddea065a72208. Bounded UI slice; no graph/auth/backend changes.

Spots are statement cards with a source/status line, shared/untrusted provenance retained, and local recorded date. An explicit Inferred Spots filter operates only on the returned page. It is not called Needs review because inference alone does not prove a pending review; server-wide filters/counts are not invented. Next-page and partial/empty state semantics are preserved. No Removing filter is added because removal-retained records are withheld from this read; the separate removal receipt remains authoritative.

Detail puts writer evidence and unavailable original-message pointer explanation up front, while kind/raw source/origin/seen count go under keyboard-native Technical details. No source pointer becomes a link. Existing action reviews, eligibility, correction-to-chat and destructive receipts remain unchanged. Statement cards and action controls use 44px minimum targets.

Red-first evidence-order/disclosure test, mounted page-local filter test, existing partial/invalid-source and action-recovery tests. 168 tests / 18 files plus TypeScript/Vite and assets verification. Synthetic Spots list and detail inspected desktop/mobile; no page-wide overflow. This is source/local evidence, not hosted mutation proof. Remaining P2 work includes outcome-focused Today/Patrol disclosure, source scroll restoration and actual action receipts; none claimed finished here.
