import { z } from 'zod';
import { artifactKindSchema } from '../tools/schemas/artifacts';
export const APP_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const APP_FILE_MAX_REQUEST_BYTES = APP_FILE_MAX_BYTES + 64 * 1024;
export const APP_FILE_TEXT_MAX_BYTES = 256 * 1024;
export const APP_FILE_TEXT_MAX_REQUEST_BYTES = 300 * 1024;
export const appFileTextFits = (text: string): boolean => {
  let bytes = 0;
  for (const character of text) { const point = character.codePointAt(0)!; bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; }
  return bytes <= APP_FILE_TEXT_MAX_BYTES;
};

export const appFileIdV1Schema = z.uuid();
export const appArtifactIdV1Schema = z.string().regex(/^art:[a-zA-Z0-9_-]{1,128}$/);
const revision = z.int().positive();
const operationId = z.uuid();
const path = z.string().min(1).max(240);
export const appFilesQueryV1Schema = z.strictObject({ cursor: appFileIdV1Schema.optional(), limit: z.coerce.number().int().min(1).max(50).default(20), prefix: z.string().max(240).default('') });
export const appFileSearchQueryV1Schema = z.strictObject({ query: z.string().min(1).max(200), prefix: z.string().max(240).default(''), limit: z.coerce.number().int().min(1).max(20).default(10) });
export const appFileContentQueryV1Schema = z.strictObject({ revision: z.coerce.number().int().positive() });
export const appArtifactReadQueryV1Schema = z.strictObject({ revision: z.coerce.number().int().positive().optional(), offset: z.coerce.number().int().nonnegative().default(0), length: z.coerce.number().int().min(1).max(8000).default(4000) });
export const appArtifactsQueryV1Schema = z.strictObject({ kind: artifactKindSchema.optional() });
export const appFileRemoveV1Schema = z.strictObject({ expected_revision: revision });
export const appFileRenderV1Schema = z.strictObject({ source_revision: revision, path, expected_revision: z.int().nonnegative(), format: z.enum(['pdf', 'docx']), operation_id: operationId });
export const appArtifactExportV1Schema = z.strictObject({ source_revision: revision, path, expected_revision: z.int().nonnegative(), format: z.enum(['markdown', 'pdf', 'docx']), operation_id: operationId });
export const appFileWriteV1Schema = z.strictObject({ path, expected_revision: z.int().nonnegative(), mime: z.enum(['text/plain', 'text/markdown']), text: z.string().max(APP_FILE_TEXT_MAX_BYTES).refine(appFileTextFits, 'Text exceeds UTF-8 byte limit'), operation_id: operationId });
export const appFileUploadFieldsV1Schema = z.strictObject({ path, expected_revision: z.coerce.number().int().nonnegative(), operation_id: operationId });
export const appFileV1Schema = z.strictObject({
  storage: z.literal('workspace'), artifact_id: appFileIdV1Schema, revision,
  path, mime: z.string(), byte_size: z.int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: z.enum(['owner_upload', 'agent_generated', 'provider_import', 'sandbox_output']),
  created_at: z.int().nonnegative(), updated_at: z.int().nonnegative(),
});
export const appArtifactV1Schema = z.strictObject({ storage: z.literal('artifact'), artifact_id: appArtifactIdV1Schema, revision, name: z.string(), kind: artifactKindSchema, byte_size: z.int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), integrity: z.enum(['verified_original', 'legacy_original_unverified']).optional(), created_at: z.int().nonnegative(), updated_at: z.int().nonnegative() });
export const appArtifactDeliveryV1Schema = z.strictObject({ status: z.enum(['saved_internal', 'owner_link']), url: z.string().nullable(), audience: z.enum(['unverified', 'owner_authenticated']) });
export const appFileResultV1Schema = z.strictObject({ file: appFileV1Schema, delivery: appArtifactDeliveryV1Schema.optional() });
export const appFilesResultV1Schema = z.strictObject({ files: z.array(appFileV1Schema), next_cursor: appFileIdV1Schema.nullable() });
export const appArtifactsResultV1Schema = z.strictObject({ artifacts: z.array(appArtifactV1Schema) });
export const appArtifactReadResultV1Schema = z.strictObject({ artifact: appArtifactV1Schema, text: z.string(), offset: z.int().nonnegative(), total_chars: z.int().nonnegative(), next_offset: z.int().nonnegative().nullable(), source_taint: z.literal('external') });
export const appFileRemoveResultV1Schema = z.strictObject({ status: z.enum(['purged', 'cleanup_pending']) });
export const appFileSearchResultV1Schema = z.strictObject({ hits: z.array(z.strictObject({ file_id: appFileIdV1Schema, path, revision, offset: z.int().nonnegative(), snippet: z.string() })), truncated: z.boolean() });
export const appFileRevisionsResultV1Schema = z.strictObject({ artifact_id: appFileIdV1Schema, revisions: z.array(z.strictObject({ revision, mime: z.string(), provenance: z.enum(['owner_upload', 'agent_generated', 'provider_import', 'sandbox_output']), created_at: z.int().nonnegative(), byte_size: z.int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })) });
export const appArtifactRevisionsResultV1Schema = z.strictObject({ artifact_id: appArtifactIdV1Schema, revisions: z.array(appArtifactV1Schema) });
export const appFileOperationKindV1Schema = z.enum(['upload', 'text_write', 'document_export']);
export const appFileOperationQueryV1Schema = z.strictObject({ kind: appFileOperationKindV1Schema });
export const appFileOperationMutationV1Schema = z.strictObject({ kind: appFileOperationKindV1Schema, expected_fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
export const appFileOperationResultV1Schema = z.strictObject({ operation_id: operationId, kind: appFileOperationKindV1Schema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['pending', 'committed', 'cancel_requested', 'cancelled']), reserved_at: z.int().nonnegative(), file: appFileV1Schema.nullable() });
export const appArtifactRoutesV1 = [
  { method: 'GET', path: '/app/v1/files', query: appFilesQueryV1Schema, response: appFilesResultV1Schema },
  { method: 'POST', path: '/app/v1/files', request: appFileUploadFieldsV1Schema, request_media_type: 'multipart/form-data', max_request_bytes: APP_FILE_MAX_REQUEST_BYTES, response: appFileResultV1Schema },
  { method: 'GET', path: '/app/v1/files/search', query: appFileSearchQueryV1Schema, response: appFileSearchResultV1Schema },
  { method: 'POST', path: '/app/v1/files/write', request: appFileWriteV1Schema, max_request_bytes: APP_FILE_TEXT_MAX_REQUEST_BYTES, response: appFileResultV1Schema },
  { method: 'GET', path: '/app/v1/files/operations/{operation_id}', query: appFileOperationQueryV1Schema, response: appFileOperationResultV1Schema },
  { method: 'POST', path: '/app/v1/files/operations/{operation_id}/reconcile', request: appFileOperationMutationV1Schema, response: appFileOperationResultV1Schema },
  { method: 'POST', path: '/app/v1/files/operations/{operation_id}/cancel', request: appFileOperationMutationV1Schema, response: appFileOperationResultV1Schema },
  { method: 'GET', path: '/app/v1/files/{file_id}', response: appFileResultV1Schema },
  { method: 'GET', path: '/app/v1/files/{file_id}/revisions', response: appFileRevisionsResultV1Schema },
  { method: 'GET', path: '/app/v1/files/{file_id}/content', query: appFileContentQueryV1Schema, response: z.string(), response_media_type: 'application/octet-stream' },
  { method: 'POST', path: '/app/v1/files/{file_id}/remove', request: appFileRemoveV1Schema, response: appFileRemoveResultV1Schema },
  { method: 'POST', path: '/app/v1/files/{file_id}/render', request: appFileRenderV1Schema, response: appFileResultV1Schema },
  { method: 'GET', path: '/app/v1/artifacts', query: appArtifactsQueryV1Schema, response: appArtifactsResultV1Schema },
  { method: 'GET', path: '/app/v1/artifacts/{artifact_id}', query: appArtifactReadQueryV1Schema, response: appArtifactReadResultV1Schema },
  { method: 'GET', path: '/app/v1/artifacts/{artifact_id}/revisions', response: appArtifactRevisionsResultV1Schema },
  { method: 'POST', path: '/app/v1/artifacts/{artifact_id}/export', request: appArtifactExportV1Schema, response: appFileResultV1Schema },
] as const;
