import { describe, expect, it } from 'vitest';
import type { WorkspaceFile, WorkspaceMount } from '../index';
import {
  stagedWorkspaceWriteSchema,
  workspaceBlobSchema,
  workspaceFileSchema,
  workspacePrefixSchema,
  workspaceVersionSchema,
  workspaceWriteIdSchema,
  workspaceWriteOptionsSchema,
} from './workspace';

describe('workspace contract', () => {
  it('admits only logical static files and a kebab-case user skill descriptor', () => {
    expect(workspaceFileSchema.parse({ kind: 'today' })).toEqual({ kind: 'today' });
    expect(workspaceFileSchema.parse({ kind: 'user_skill', name: 'weekly-review' })).toEqual({
      kind: 'user_skill',
      name: 'weekly-review',
    });
  });

  it('lets a fake owner-bound mount use opaque versions and staged ids', async () => {
    const version = workspaceVersionSchema.parse('v-test-1');
    const content = workspaceBlobSchema.parse({ bytes: Uint8Array.of(2), version });
    const readResult = workspaceBlobSchema.parse({ bytes: Uint8Array.of(1), version });
    const committedWriteId = workspaceWriteIdSchema.parse('stage-commit');
    const discardedWriteId = workspaceWriteIdSchema.parse('stage-discard');
    const fakeMount: WorkspaceMount = {
      readFile: async (file) => {
        expect(file).toEqual({ kind: 'today' });
        return readResult;
      },
      writeFile: async (_file, receivedContent, options) => {
        expect(receivedContent).toEqual(content);
        expect(options).toEqual({ expected_version: version });
        return stagedWorkspaceWriteSchema.parse({ write_id: 'stage-1' });
      },
      list: async () => [{ kind: 'user_skill', name: 'weekly-review' }],
      commit: async (writeId) => {
        expect(writeId).toBe(committedWriteId);
      },
      discard: async (writeId) => {
        expect(writeId).toBe(discardedWriteId);
      },
    };

    await expect(fakeMount.readFile({ kind: 'today' })).resolves.toEqual(readResult);
    const listed: WorkspaceFile[] = await fakeMount.list(
      workspacePrefixSchema.parse({ kind: 'user_skills' }),
    );
    expect(listed).toEqual([
      { kind: 'user_skill', name: 'weekly-review' },
    ]);
    expect(workspaceWriteOptionsSchema.parse({ expected_version: version })).toEqual({
      expected_version: version,
    });
    await expect(
      fakeMount.writeFile({ kind: 'today' }, content, { expected_version: version }),
    ).resolves.toEqual({ write_id: 'stage-1' });
    await expect(fakeMount.commit(committedWriteId)).resolves.toBeUndefined();
    await expect(fakeMount.discard(discardedWriteId)).resolves.toBeUndefined();
  });

  it('rejects raw paths, traversal-like names, unknown kinds, and hidden object keys', () => {
    expect(workspaceFileSchema.parse({ kind: 'baselines' })).toEqual({ kind: 'baselines' });
    expect(workspaceFileSchema.parse({ kind: 'patterns' })).toEqual({ kind: 'patterns' });
    expect(workspaceFileSchema.safeParse('skills/user/weekly-review.md').success).toBe(false);
    expect(
      workspaceFileSchema.safeParse({ kind: 'user_skill', name: '../weekly-review' }).success,
    ).toBe(false);
    expect(workspaceFileSchema.safeParse({ kind: 'archive', name: 'manifest' }).success).toBe(false);
    expect(workspaceFileSchema.safeParse({ kind: 'today', object_key: 'secret' }).success).toBe(
      false,
    );
  });

  it('rejects generic prefixes and storage identity hidden in result objects', () => {
    const version = workspaceVersionSchema.parse('v1');
    const writeId = workspaceWriteIdSchema.parse('s1');

    expect(version).toBe('v1');
    expect(writeId).toBe('s1');
    expect(workspacePrefixSchema.parse({ kind: 'user_skills' })).toEqual({ kind: 'user_skills' });
    expect(workspacePrefixSchema.safeParse({ kind: 'archive' }).success).toBe(false);
    expect(workspacePrefixSchema.safeParse({ kind: 'user_skills', prefix: 'skills' }).success).toBe(
      false,
    );
    expect(workspaceVersionSchema.safeParse('').success).toBe(false);
    expect(workspaceWriteIdSchema.safeParse('').success).toBe(false);
    expect(workspaceBlobSchema.parse({ bytes: Uint8Array.of(1), version })).toEqual({
      bytes: Uint8Array.of(1),
      version,
    });
    expect(workspaceBlobSchema.safeParse({ bytes: [1], version }).success).toBe(false);
    expect(workspaceBlobSchema.safeParse({ bytes: Uint8Array.of(1), version, bucket: 'r2' }).success).toBe(
      false,
    );
    expect(workspaceWriteOptionsSchema.parse({ expected_version: version })).toEqual({
      expected_version: version,
    });
    expect(workspaceWriteOptionsSchema.safeParse({ expected_version: '' }).success).toBe(false);
    expect(workspaceWriteOptionsSchema.safeParse({ owner_id: 'user-a' }).success).toBe(false);
    expect(stagedWorkspaceWriteSchema.parse({ write_id: writeId })).toEqual({ write_id: writeId });
    expect(stagedWorkspaceWriteSchema.safeParse({ write_id: '' }).success).toBe(false);
    expect(stagedWorkspaceWriteSchema.safeParse({ write_id: writeId, owner_id: 'user-a' }).success).toBe(
      false,
    );
  });
});
