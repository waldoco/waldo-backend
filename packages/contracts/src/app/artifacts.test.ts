import { expect, it } from 'vitest';
import { appArtifactExportV1Schema, appArtifactReadQueryV1Schema, appArtifactRoutesV1, appFileRenderV1Schema, appFileUploadFieldsV1Schema, appFileWriteV1Schema } from './artifacts';

it('validates exact versioned file and artifact mutations while rejecting client owner and audience fields', () => {
  const mutation = { source_revision: 1, path: 'brief.docx', expected_revision: 0, format: 'docx', operation_id: '0b17a0e1-9b0e-4234-8843-c695b25b2319' };
  expect(appFileRenderV1Schema.safeParse(mutation).success).toBe(true);
  expect(appArtifactExportV1Schema.safeParse({ ...mutation, format: 'markdown', path: 'brief.md' }).success).toBe(true);
  for (const schema of [appFileRenderV1Schema, appArtifactExportV1Schema]) {
    expect(schema.safeParse({ ...mutation, owner_id: 'another-owner' }).success).toBe(false);
    expect(schema.safeParse({ ...mutation, audience: 'public' }).success).toBe(false);
    expect(schema.safeParse({ ...mutation, source_revision: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...mutation, operation_id: 'unstable' }).success).toBe(false);
  }
  expect(appFileWriteV1Schema.safeParse({ path: 'brief.md', expected_revision: 1, mime: 'text/markdown', text: 'Owner edit', operation_id: mutation.operation_id }).success).toBe(true);
  expect(appFileUploadFieldsV1Schema.parse({ path: 'photo.png', expected_revision: '0', operation_id: mutation.operation_id }).expected_revision).toBe(0);
  expect(appFileUploadFieldsV1Schema.safeParse({ path: 'photo.png', expected_revision: 'NaN', operation_id: mutation.operation_id }).success).toBe(false);
  expect(appArtifactReadQueryV1Schema.safeParse({ revision: '2', length: '8001' }).success).toBe(false);
  expect(appArtifactRoutesV1.filter(route => route.path === '/app/v1/files').map(route => route.method)).toEqual(['GET', 'POST']);
});
