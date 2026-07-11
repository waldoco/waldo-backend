import { z } from 'zod';
import { skillNameSchema } from '../prompt/skill';

export const workspaceFileSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('today') }),
  z.strictObject({ kind: z.literal('baselines') }),
  z.strictObject({ kind: z.literal('patterns') }),
  z.strictObject({ kind: z.literal('user_skill'), name: skillNameSchema }),
]);
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

export const workspacePrefixSchema = z.strictObject({ kind: z.literal('user_skills') });
export type WorkspacePrefix = z.infer<typeof workspacePrefixSchema>;

export const workspaceVersionSchema = z.string().min(1).brand<'WorkspaceVersion'>();
export type WorkspaceVersion = z.infer<typeof workspaceVersionSchema>;

export const workspaceWriteIdSchema = z.string().min(1).brand<'WorkspaceWriteId'>();
export type WorkspaceWriteId = z.infer<typeof workspaceWriteIdSchema>;

export const workspaceBlobSchema = z.strictObject({
  bytes: z.instanceof(Uint8Array),
  version: workspaceVersionSchema,
});
export type WorkspaceBlob = z.infer<typeof workspaceBlobSchema>;

export const workspaceWriteOptionsSchema = z.strictObject({
  expected_version: workspaceVersionSchema.optional(),
});
export type WorkspaceWriteOptions = z.infer<typeof workspaceWriteOptionsSchema>;

export const stagedWorkspaceWriteSchema = z.strictObject({ write_id: workspaceWriteIdSchema });
export type StagedWorkspaceWrite = z.infer<typeof stagedWorkspaceWriteSchema>;

export interface WorkspaceMount {
  readFile(file: WorkspaceFile): Promise<WorkspaceBlob>;
  writeFile(
    file: WorkspaceFile,
    content: Uint8Array,
    options?: WorkspaceWriteOptions,
  ): Promise<StagedWorkspaceWrite>;
  list(prefix: WorkspacePrefix): Promise<readonly WorkspaceFile[]>;
  commit(writeId: WorkspaceWriteId): Promise<void>;
  discard(writeId: WorkspaceWriteId): Promise<void>;
}
