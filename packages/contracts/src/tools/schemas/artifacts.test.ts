import { describe, expect, it } from 'vitest';
import { ARTIFACT_BODY_MAX_CHARS, createArtifactArgsSchema, listArtifactsArgsSchema, readArtifactArgsSchema, reviseArtifactArgsSchema } from './artifacts';

describe('artifact tool args (A5)', () => {
  it('create requires a name, a typed kind and a bounded body', () => {
    expect(createArtifactArgsSchema.safeParse({ name: 'Brief', kind: 'research', body_markdown: 'x' }).success).toBe(true);
    expect(createArtifactArgsSchema.safeParse({ name: '', kind: 'research', body_markdown: 'x' }).success).toBe(false);
    expect(createArtifactArgsSchema.safeParse({ name: 'B', kind: 'note', body_markdown: 'x' }).success).toBe(false);
    expect(createArtifactArgsSchema.safeParse({ name: 'B', kind: 'research', body_markdown: '' }).success).toBe(false);
    expect(createArtifactArgsSchema.safeParse({ name: 'B', kind: 'research', body_markdown: 'x'.repeat(ARTIFACT_BODY_MAX_CHARS + 1) }).success).toBe(false);
    expect(createArtifactArgsSchema.safeParse({ name: 'B', kind: 'research', body_markdown: 'x', extra: 1 }).success).toBe(false);
  });
  it('revise requires a positive expected revision', () => {
    expect(reviseArtifactArgsSchema.safeParse({ artifact_id: 'art:1', expected_revision: 1, body_markdown: 'x' }).success).toBe(true);
    expect(reviseArtifactArgsSchema.safeParse({ artifact_id: 'art:1', expected_revision: 0, body_markdown: 'x' }).success).toBe(false);
  });
  it('read defaults the window and caps the length at 8000', () => {
    const parsed = readArtifactArgsSchema.parse({ artifact_id: 'art:1' });
    expect(parsed.offset).toBe(0);
    expect(parsed.length).toBe(4000);
    expect(readArtifactArgsSchema.safeParse({ artifact_id: 'art:1', length: 8001 }).success).toBe(false);
    expect(readArtifactArgsSchema.safeParse({ artifact_id: 'art:1', offset: -1 }).success).toBe(false);
  });
  it('list takes an optional kind filter only', () => {
    expect(listArtifactsArgsSchema.safeParse({}).success).toBe(true);
    expect(listArtifactsArgsSchema.safeParse({ kind: 'data' }).success).toBe(true);
    expect(listArtifactsArgsSchema.safeParse({ kind: 'other' }).success).toBe(false);
  });
});
