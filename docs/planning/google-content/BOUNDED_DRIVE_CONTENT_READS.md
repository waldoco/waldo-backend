# Bounded Drive content reads

## Decision and scope

User job: find a document and read/summarize its actual contents. Existing `read_drive` only listed metadata; metadata alone cannot substantiate a content summary.

Reuse the existing signed Google connector proxy and Vault grant. Extend `read_drive` with `action: content`, while keeping recent/search/get field names and metadata projections compatible. Metadata receipts add the currently selected `account.connection_id`. Content requires that identity plus the selected file's modifiedTime. No credential, OAuth scope, framework, dependency, migration or fallback is introduced.

Supported: a bounded text preview of Google Docs exported as text/plain and native Drive text/plain blobs through alt=media. Unsupported: content pagination/full reads beyond the preview, PDFs/OCR, office binaries, Sheets/Slides, shortcuts, arbitrary links and writes. Unsupported types return a typed refusal without downloading. A prefix can inform a partial summary; it never substantiates a full-document summary.

## Boundaries

- The existing signed proxy resolves the named owner's exact connection using proxy_access. Foreign/revoked connections fail before token refresh. Content needs an existing explicit drive.readonly scope; metadata-only grants retain metadata access but cannot download. No scope auto-upgrade occurs
- The content handler refuses account changes between metadata selection and content execution. The adapter rechecks exact file ID, modifiedTime and provider version before and after the content read. Changed source discards the body with drive_source_changed. This is a current observation, not a historical revision or stable-result replay guarantee
- Fixed Google Drive API endpoints, redirect:error, an explicit MIME allowlist and canDownload validation prevent arbitrary URL/link traversal. Returned content must be text/plain and valid UTF-8
- Stream accepts at most 8,192 bytes, with an additional 8,192-character escaped JSON text budget. The handler prepares the complete data/account projection with the same external internal_context Scribe policy, then caps that post-redaction envelope at 14,000 JSON characters. Normal dispatcher hooks still run. Further cuts update truncated; returnedBytes counts the visible sanitized text, not raw source bytes. Dense-PII expansion is covered with a real dispatcher/offload-spy fixture. A 10-second operation timeout aborts transport and prevents delayed refresh from starting a later provider fetch
- Every success and handler refusal is external content. Existing dispatcher/Scribe rules remain in force; injection-bearing content cannot become action authority. Complete content stays inline under current dispatcher/conversation limits, never silently offloaded
- Drive proxy calls bypass effect intent claim/store and stable-result replay. Proxy logs and health diagnostics use typed codes only; provider body, errors and credential values are never emitted there

## Retention is inherited, not eliminated

No new persistent content cache or proxy intent result ledger is introduced. This does not mean no retention anywhere. Normal owner-turn tool-output summaries and capture-enabled conversational/provider traces inherit the same policy as existing Gmail body reads. Model input receives the bounded Scribe-governed body. Provider outputs and owner-visible summaries may reflect it. This candidate does not broaden or replace that existing policy; any stronger non-retention promise needs a separately reviewed shared owner-turn change.

## Integration and acceptance

`readDriveHandler` defaults content off until the owner registry explicitly enables the completed boundary. The release owner must integrate the one-line registration change from `readDriveHandler(google, this.env.DRIVE_READS === '1')` to `readDriveHandler(google, this.env.DRIVE_READS === '1', this.env.DRIVE_READS === '1')`. The existing flag is reused. There is no deployment/publication authorization in this packet.

Local synthetic tests cover actual dispatcher → handler → signed proxy → edge grant → official REST transport → content response, compatibility metadata, source changes, unsupported MIME, revoked/foreign grants, scope restrictions, truncation/Unicode/escaped budgets, stalled refresh, injection and redacted logs. Local mocks do not prove live owner account access, Google app verification, production latency, quota availability or serving enablement.

## Official references verified 2026-10-03

- https://developers.google.com/workspace/drive/api/guides/manage-downloads : blob files use files.get alt=media; native Workspace documents use files.export; metadata-only scopes do not permit download
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export : returned bytes, supported readonly scope, Google's 10 MB export ceiling
- https://developers.google.com/workspace/drive/api/guides/ref-export-formats : Google Docs supports text/plain export
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files : version changes on server changes, modifiedTime and capabilities.canDownload

Adapted directly from official REST semantics into the existing adapter. No upstream code was copied; no additional licensing or package obligations were introduced.
