import { z } from 'zod';
import type { AdapterResult } from '../core/error';
import { errorCodeSchema, iso8601Schema } from '../core/error';
import { idempotencyKeySchema } from '../runtime/outbox';

// Single owner of doc-provider literals (ADR-0025). The R2 scratch space is 'r2_scratch'
// everywhere — one concept, one representation; a bare 'scratch' literal is drift. r2_scratch
// is always-available for L1 users (no OAuth) and is the default write destination.
export const docProviderSchema = z.enum(['drive', 'notion', 'confluence', 'r2_scratch']);
export type DocProvider = z.infer<typeof docProviderSchema>;

// ADR-0025's Drive note refuses binary types with 'unsupported_type', yet its own ErrorCode
// union omits the literal. Documented divergence: the code joins this doc-local enum, derived
// from core/error's seven so core drift surfaces here, and core/error stays untouched.
export const docErrorCodeSchema = z.enum([...errorCodeSchema.options, 'unsupported_type']);
export type DocErrorCode = z.infer<typeof docErrorCodeSchema>;

// Widens the core envelope with the one doc-local failure. Every AdapterResult<T> remains
// assignable; 'unsupported_type' stays unrepresentable in core-coded results.
export type DocAdapterResult<T> =
  | AdapterResult<T>
  | { ok: false; error: string; code: 'unsupported_type' };

export const docErrorBucketSchema = z.enum(['user_fixable', 'transient', 'model_recoverable']);
export type DocErrorBucket = z.infer<typeof docErrorBucketSchema>;

// ADR-0025 bucket taxonomy for tool-layer error handling. Total coverage is compile-enforced
// by the Record key domain. unsupported_type classifies model_recoverable: the model can pick
// a different doc or skip the binary — nothing for the user to fix, nothing worth a retry.
export const DOC_ERROR_BUCKET: Readonly<Record<DocErrorCode, DocErrorBucket>> = {
  auth_failed: 'user_fixable',
  not_found: 'user_fixable',
  forbidden: 'user_fixable',
  rate_limited: 'transient',
  transient: 'transient',
  oversize: 'model_recoverable',
  invalid_args: 'model_recoverable',
  unsupported_type: 'model_recoverable',
};

// ADR-0025 pins the scratch key shape. The 'scratch' path segment inside the key is an R2
// prefix — distinct from the provider literal 'r2_scratch'.
export const R2_SCRATCH_DOC_ID = /^workspace\/[^/]+\/scratch\/[^/]+\.md$/;

// Search hits are the privacy wall: title + url + snippet only — body content enters model
// context solely via an explicit read() (ADR-0025).
export const docHitSchema = z
  .strictObject({
    provider: docProviderSchema,
    doc_id: z.string().min(1),
    title: z.string().min(1),
    url: z.url(),
    snippet: z.string(),
    date_modified: iso8601Schema,
    parent: z.strictObject({ id: z.string().min(1), name: z.string().min(1) }).nullable(),
  })
  .refine((hit) => hit.provider !== 'r2_scratch' || R2_SCRATCH_DOC_ID.test(hit.doc_id), {
    error: 'r2_scratch doc_id must be a workspace/{user_id}/scratch/{uuid}.md key',
    path: ['doc_id'],
  });
export type DocHit = z.infer<typeof docHitSchema>;

export const docReadResultSchema = z.strictObject({
  doc_id: z.string().min(1),
  title: z.string().min(1),
  body_markdown: z.string(),
  url: z.url(),
  date_modified: iso8601Schema,
  size_bytes: z.int().nonnegative(),
});
export type DocReadResult = z.infer<typeof docReadResultSchema>;

export const docSearchArgsSchema = z.strictObject({
  query: z.string().min(1),
  parent_folder_id: z.string().min(1).optional(),
  time_range: z.strictObject({ from: iso8601Schema, to: iso8601Schema }).optional(),
  limit: z.int().min(1).max(50).default(10),
});
export type DocSearchArgs = z.infer<typeof docSearchArgsSchema>;

export const docReadArgsSchema = z.strictObject({ doc_id: z.string().min(1) });
export type DocReadArgs = z.infer<typeof docReadArgsSchema>;

// body_markdown arrives already Scribe-sanitised (ADR-0024) — providers never see raw content.
// idempotency_key = hash(user_id + content + 5-min bucket), in the repo-canonical 64-hex form:
// a Worker retry collapses onto the same doc while genuinely new content mints a new one.
export const docWriteArgsSchema = z.strictObject({
  title: z.string().min(1),
  body_markdown: z.string(),
  parent_folder_id: z.string().min(1).optional(),
  shareable: z.boolean().optional(),
  idempotency_key: idempotencyKeySchema,
});
export type DocWriteArgs = z.infer<typeof docWriteArgsSchema>;

export const docWriteResultSchema = z.strictObject({
  doc_id: z.string().min(1),
  url: z.url(),
});
export type DocWriteResult = z.infer<typeof docWriteResultSchema>;

export const docFolderSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type DocFolder = z.infer<typeof docFolderSchema>;

export const docListFoldersArgsSchema = z.strictObject({
  parent_folder_id: z.string().min(1).optional(),
});
export type DocListFoldersArgs = z.infer<typeof docListFoldersArgsSchema>;

// Conformance rule (ADR-0025): r2_scratch is user-private — a shareable scratch write is a
// contract violation regardless of caller.
export function r2ScratchWriteIsPrivate(provider: DocProvider, args: DocWriteArgs): boolean {
  return provider !== 'r2_scratch' || args.shareable !== true;
}

// The DocAdapter seam (ADR-0025): one contract across Drive, Notion, Confluence, and
// r2_scratch, so tool handlers never branch on provider. Methods resolve coded failures
// instead of throwing; parent_folder_id stays an opaque string across all four providers.
export interface DocAdapter {
  provider: DocProvider;
  search(args: DocSearchArgs): Promise<DocAdapterResult<DocHit[]>>;
  read(args: DocReadArgs): Promise<DocAdapterResult<DocReadResult>>;
  write(args: DocWriteArgs): Promise<DocAdapterResult<DocWriteResult>>;
  list_folders(args: DocListFoldersArgs): Promise<DocAdapterResult<DocFolder[]>>;
}
