import { describe, expect, it } from 'vitest';
import { EXTRACT_ARCHIVE_MAX_ENTRIES, extractArchiveArgsSchema, workspaceReadArgsSchema } from './workspace';

describe('extract_archive arguments', () => {
  it('accepts a workspace file with no selection, named entries, or a prefix', () => {
    expect(extractArchiveArgsSchema.safeParse({ file_id: 'f', revision: 1 }).success).toBe(true);
    expect(extractArchiveArgsSchema.safeParse({ file_id: 'f', revision: 1, entries: ['a/b.txt'] }).success).toBe(true);
    expect(extractArchiveArgsSchema.safeParse({ file_id: 'f', revision: 1, prefix: 'docs/' }).success).toBe(true);
  });
  it('refuses a missing revision, both selections at once, too many entries, a destination, or unknown keys', () => {
    expect(extractArchiveArgsSchema.safeParse({ file_id: 'f' }).success).toBe(false);
    expect(extractArchiveArgsSchema.safeParse({ file_id: 'f', revision: 1, entries: ['a'], prefix: 'b' }).success).toBe(false);
    expect(extractArchiveArgsSchema.safeParse({ file_id: 'f', revision: 1, entries: Array.from({ length: EXTRACT_ARCHIVE_MAX_ENTRIES + 1 }, (_, i) => `e${i}`) }).success).toBe(false);
    expect(extractArchiveArgsSchema.safeParse({ file_id: 'f', revision: 1, entries: [] }).success).toBe(false);
    expect(extractArchiveArgsSchema.safeParse({ file_id: 'f', revision: 1, destination: '/etc' }).success).toBe(false);
    expect(extractArchiveArgsSchema.safeParse({ file_id: 'f', revision: 0 }).success).toBe(false);
  });
});

describe('workspace_read arguments', () => {
  it('pages a file by byte offset and length', () => {
    expect(workspaceReadArgsSchema.safeParse({ file_id: 'f', revision: 1, offset: 8000, length: 8000 }).success).toBe(true);
  });
  it('refuses a negative offset or an oversized page', () => {
    expect(workspaceReadArgsSchema.safeParse({ file_id: 'f', revision: 1, offset: -1 }).success).toBe(false);
    expect(workspaceReadArgsSchema.safeParse({ file_id: 'f', revision: 1, length: 8001 }).success).toBe(false);
  });
});
