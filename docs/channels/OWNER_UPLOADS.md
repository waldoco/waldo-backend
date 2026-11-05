# Owner uploads: storage, retention and egress

When `WALDO_FILE_TOOLS` is "1" (staging), every file the owner sends Waldo is kept in their private workspace. Before that switch, the bytes lived only for the turn that received them. This document owns that storage. Code: `packages/runtime/src/channels/upload-keeper.ts` and `packages/workspace`.

## What is kept

| Surface | What is kept | Provenance | Path |
|---|---|---|---|
| Telegram, WhatsApp | Every photo and document. Voice notes and audio are not kept (they are transcribed) | `owner_upload`; a forwarded file is `provider_import` | `uploads/<8 hex>/<file name>` |
| iMessage (Photon) | Every file in the message, except voice notes | `owner_upload` | `uploads/<8 hex>/<file name>` |
| Mail to the owner's Waldo address | Every attached file, but not parts the mail shows inline, and nothing from a mail the Scribe withholds | `provider_import`, because a mail is third-party text | `mail/<8 hex>/<file name>` |
| The app | Nothing yet. The app has no file upload | n/a | n/a |

This covers whatever the owner sends, health documents included (for example a lab report PDF or a photo of a prescription). Under the repository rules in `CLAUDE.md`, a document the owner sends is normal agent context within the owner's authorization: it is kept in R2 in their own workspace and the model may read it. ADR-0081 (as amended by `docs/app/HEALTH_PLANE_AMENDMENT.md`) governs synced wearable readings only. Those stay on the Supabase health plane and are never written into the workspace. A kept file is never copied into memory, logs, traces or the health plane.

## Where it lives

- **Bytes:** the `ARTIFACTS` R2 bucket, under the owner's workspace prefix `workspace/v1/<environment>/<namespace>/<owner id>/`. Every read and write is admitted against the owner's directory binding.
- **Metadata** (path, file id, revision, size, hash, provenance): the owner object's `workspace_manifest` in Durable Object SQLite.
- **Taint:** every workspace file is tainted `external`. What the model reads from it is data, never instructions.

## Limits

- 10 MB per file.
- 100 MB per owner.
- 500 files.
- 500 write receipts for the life of the workspace. Nothing prunes them yet, so after 500 writes the workspace refuses new files as full. Pruning is a follow-up.

A file over a limit is not kept, and the turn's note says why.

## Retention and deletion

- Files stay until the owner removes them or deletes their account.
- **Remove:** the console's workspace page tombstones a file and purges its bytes.
- **Account deletion:** it purges the owner's whole workspace prefix before anything else is deleted (`owner-files-purge.ts`). If the purge cannot be confirmed, the deletion stops, and the request can be made again.
- There is no automatic expiry. If one is wanted, it is a later owner decision.

## Egress

A kept file leaves the workspace only in these cases:
- to the model provider, when a turn attaches a readable type, or the model reads it through the workspace tools within the owner's authorization;
- to the owner's own chat through `attach_file`;
- to the owner through the owner-authenticated console link.

It is not sent to a third party unless the owner asks for that specific item. Logs carry fixed codes only (`upload_keep` with a code), never a file name, path or content.
