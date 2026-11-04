// Owning ADR: ADR-0025 (DocAdapter contract). Rejected framing recorded: mapping binary
// refusal onto invalid_args/oversize — the wave ships 'unsupported_type' as a doc-local
// literal instead, leaving core/error's eight-code union untouched.
// Invariants under test: provider literals are exactly the four ADR providers ('scratch' is
// not one); the doc-local error enum is core's eight codes plus 'unsupported_type'; the bucket
// map totally covers the enum; search hits carry title + url + snippet only (no body key);
// writes demand a canonical idempotency key; r2_scratch stays user-private (shareable=true
// refused) and keeps its documented key shape; search limit defaults 10 and caps at 50.
// Failure modes caught: a bare 'scratch' literal splitting the r2_scratch concept, binary
// refusal minted into core/error, an unmapped error code, body content leaking through a
// search hit, an uncapped search limit, and a shareable scratch write.
import { describe, expect, it } from 'vitest';
import type { AdapterResult } from '../core/error';
import { errorCodeSchema } from '../core/error';
import type { DocAdapter, DocHit, DocReadResult } from './doc';
import {
  DOC_ERROR_BUCKET,
  docErrorBucketSchema,
  docErrorCodeSchema,
  docFolderSchema,
  docHitSchema,
  docListFoldersArgsSchema,
  docProviderSchema,
  docReadArgsSchema,
  docReadResultSchema,
  docSearchArgsSchema,
  docWriteArgsSchema,
  docWriteResultSchema,
  r2ScratchWriteIsPrivate,
} from './doc';

const key = 'a'.repeat(64);

const baseHit = {
  provider: 'drive',
  doc_id: 'file-01',
  title: 'Q3 planning notes',
  url: 'https://docs.example.com/d/file-01',
  snippet: 'Q3 planning notes — first section',
  date_modified: '2026-07-01T10:00:00Z',
  parent: { id: 'folder-01', name: 'Planning' },
};

const scratchHit = {
  ...baseHit,
  provider: 'r2_scratch',
  doc_id: 'workspace/user-01/scratch/draft-01.md',
  parent: null,
};

const baseRead = {
  doc_id: 'file-01',
  title: 'Q3 planning notes',
  body_markdown: '# Q3\n- goals',
  url: 'https://docs.example.com/d/file-01',
  date_modified: '2026-07-01T10:00:00Z',
  size_bytes: 2_048,
};

const baseWrite = {
  title: 'Meeting summary',
  body_markdown: '## Summary',
  idempotency_key: key,
};

describe('docProvider', () => {
  it('is exactly the four ADR providers, in order', () => {
    expect(docProviderSchema.options).toEqual(['drive', 'notion', 'confluence', 'r2_scratch']);
  });

  it("rejects the bare 'scratch' literal — the scratch space is 'r2_scratch' everywhere", () => {
    expect(docProviderSchema.safeParse('scratch').success).toBe(false);
  });
});

describe('docErrorCode — doc-local divergence from core/error', () => {
  it("is exactly core's eight codes plus 'unsupported_type', in order", () => {
    expect(docErrorCodeSchema.options).toEqual([
      'auth_failed',
      'not_found',
      'forbidden',
      'rate_limited',
      'transient',
      'oversize',
      'invalid_args',
      'rejected',
      'unsupported_type',
    ]);
  });

  it("derives from core: the first eight codes are core/error's union verbatim", () => {
    expect(docErrorCodeSchema.options.slice(0, 8)).toEqual([...errorCodeSchema.options]);
  });

  it("core/error still omits 'unsupported_type' — the divergence stays doc-local by design", () => {
    expect(errorCodeSchema.safeParse('unsupported_type').success).toBe(false);
    expect(docErrorCodeSchema.safeParse('unsupported_type').success).toBe(true);
  });

  it('rejects a tenth code', () => {
    expect(docErrorCodeSchema.safeParse('binary_refused').success).toBe(false);
  });
});

describe('DOC_ERROR_BUCKET', () => {
  it('bucket vocabulary is exactly the three ADR buckets, in order', () => {
    expect(docErrorBucketSchema.options).toEqual(['user_fixable', 'transient', 'model_recoverable']);
  });

  it('maps every doc error code with no unmapped code, in enum order', () => {
    expect(Object.keys(DOC_ERROR_BUCKET)).toEqual([...docErrorCodeSchema.options]);
  });

  it('pins the ADR classification exactly', () => {
    expect(DOC_ERROR_BUCKET).toEqual({
      auth_failed: 'user_fixable',
      not_found: 'user_fixable',
      forbidden: 'user_fixable',
      rate_limited: 'transient',
      transient: 'transient',
      oversize: 'model_recoverable',
      invalid_args: 'model_recoverable',
      rejected: 'model_recoverable',
      unsupported_type: 'model_recoverable',
    });
  });
});

describe('docHit — the search privacy wall', () => {
  it('accepts a hit for each external provider', () => {
    for (const provider of ['drive', 'notion', 'confluence'] as const) {
      expect(docHitSchema.safeParse({ ...baseHit, provider }).success).toBe(true);
    }
  });

  it('accepts an r2_scratch hit with the documented workspace key and a null parent', () => {
    expect(docHitSchema.safeParse(scratchHit).success).toBe(true);
  });

  it('rejects an r2_scratch hit whose doc_id is not a scratch workspace key', () => {
    expect(docHitSchema.safeParse({ ...scratchHit, doc_id: 'file-01' }).success).toBe(false);
  });

  it('rejects a body_markdown key on a hit — body enters model context only via read()', () => {
    expect(docHitSchema.safeParse({ ...baseHit, body_markdown: '# full body' }).success).toBe(
      false,
    );
  });

  it('rejects a non-ISO date_modified', () => {
    expect(docHitSchema.safeParse({ ...baseHit, date_modified: 'yesterday' }).success).toBe(false);
  });

  it('rejects an unknown extra field (strictObject drift)', () => {
    expect(docHitSchema.safeParse({ ...baseHit, score: 0.9 }).success).toBe(false);
  });
});

describe('docSearchArgs', () => {
  it('defaults limit to 10 when absent', () => {
    expect(docSearchArgsSchema.parse({ query: 'planning' }).limit).toBe(10);
  });

  it('accepts full args at the hard max limit', () => {
    expect(
      docSearchArgsSchema.safeParse({
        query: 'planning',
        parent_folder_id: 'folder-01',
        time_range: { from: '2026-06-01T00:00:00Z', to: '2026-07-01T00:00:00Z' },
        limit: 50,
      }).success,
    ).toBe(true);
  });

  it('rejects a limit above the hard max 50', () => {
    expect(docSearchArgsSchema.safeParse({ query: 'planning', limit: 51 }).success).toBe(false);
  });

  it('rejects a non-positive limit', () => {
    expect(docSearchArgsSchema.safeParse({ query: 'planning', limit: 0 }).success).toBe(false);
  });

  it('rejects an empty query', () => {
    expect(docSearchArgsSchema.safeParse({ query: '' }).success).toBe(false);
  });

  it('rejects a time_range with a non-ISO bound', () => {
    expect(
      docSearchArgsSchema.safeParse({
        query: 'planning',
        time_range: { from: 'last week', to: '2026-07-01T00:00:00Z' },
      }).success,
    ).toBe(false);
  });
});

describe('docReadArgs and docReadResult', () => {
  it('accepts a doc_id and a full read result', () => {
    expect(docReadArgsSchema.safeParse({ doc_id: 'file-01' }).success).toBe(true);
    expect(docReadResultSchema.safeParse(baseRead).success).toBe(true);
  });

  it('rejects an empty doc_id', () => {
    expect(docReadArgsSchema.safeParse({ doc_id: '' }).success).toBe(false);
  });

  it('rejects a negative size_bytes', () => {
    expect(docReadResultSchema.safeParse({ ...baseRead, size_bytes: -1 }).success).toBe(false);
  });

  it('rejects an unknown extra field on a read result', () => {
    expect(docReadResultSchema.safeParse({ ...baseRead, embedding: [] }).success).toBe(false);
  });
});

describe('docWriteArgs', () => {
  it('accepts a minimal write and a fully-specified write', () => {
    expect(docWriteArgsSchema.safeParse(baseWrite).success).toBe(true);
    expect(
      docWriteArgsSchema.safeParse({
        ...baseWrite,
        parent_folder_id: 'folder-01',
        shareable: true,
      }).success,
    ).toBe(true);
  });

  it('rejects a write missing idempotency_key', () => {
    const missingKey: Record<string, unknown> = { ...baseWrite };
    delete missingKey['idempotency_key'];
    expect(docWriteArgsSchema.safeParse(missingKey).success).toBe(false);
  });

  it('rejects an upper-hex idempotency key — one canonical representation', () => {
    expect(
      docWriteArgsSchema.safeParse({ ...baseWrite, idempotency_key: key.toUpperCase() }).success,
    ).toBe(false);
  });

  it('rejects an unknown extra field on write args', () => {
    expect(docWriteArgsSchema.safeParse({ ...baseWrite, overwrite: true }).success).toBe(false);
  });
});

describe('r2ScratchWriteIsPrivate — conformance rule', () => {
  it('refuses a shareable r2_scratch write', () => {
    const args = docWriteArgsSchema.parse({ ...baseWrite, shareable: true });
    expect(r2ScratchWriteIsPrivate('r2_scratch', args)).toBe(false);
  });

  it('allows a private scratch write, shareable absent or false', () => {
    expect(r2ScratchWriteIsPrivate('r2_scratch', docWriteArgsSchema.parse(baseWrite))).toBe(true);
    expect(
      r2ScratchWriteIsPrivate(
        'r2_scratch',
        docWriteArgsSchema.parse({ ...baseWrite, shareable: false }),
      ),
    ).toBe(true);
  });

  it('allows a shareable write on an external provider', () => {
    const args = docWriteArgsSchema.parse({ ...baseWrite, shareable: true });
    expect(r2ScratchWriteIsPrivate('drive', args)).toBe(true);
  });
});

describe('docWriteResult and docFolder', () => {
  it('accepts a doc_id + url receipt and a folder listing shape', () => {
    expect(
      docWriteResultSchema.safeParse({ doc_id: 'file-02', url: 'https://docs.example.com/d/file-02' })
        .success,
    ).toBe(true);
    expect(docFolderSchema.safeParse({ id: 'folder-01', name: 'Planning' }).success).toBe(true);
    expect(docListFoldersArgsSchema.safeParse({}).success).toBe(true);
    expect(docListFoldersArgsSchema.safeParse({ parent_folder_id: 'folder-01' }).success).toBe(
      true,
    );
  });

  it('rejects a non-URL url on a write receipt', () => {
    expect(docWriteResultSchema.safeParse({ doc_id: 'file-02', url: 'not a url' }).success).toBe(
      false,
    );
  });

  it('rejects an empty folder name', () => {
    expect(docFolderSchema.safeParse({ id: 'folder-01', name: '' }).success).toBe(false);
  });
});

describe('DocAdapter seam — fake adapter', () => {
  const hit: DocHit = docHitSchema.parse(baseHit);

  const drive: DocAdapter = {
    provider: 'drive',
    search: async () => ({ ok: true, data: [hit] }),
    read: async () => ({ ok: false, error: 'binary type: refusing export', code: 'unsupported_type' }),
    write: async () => ({
      ok: true,
      data: { doc_id: 'file-02', url: 'https://docs.example.com/d/file-02' },
    }),
    list_folders: async () => ({ ok: true, data: [{ id: 'folder-01', name: 'Planning' }] }),
  };

  it('binary refusal resolves the doc-local code instead of throwing', async () => {
    await expect(drive.read({ doc_id: 'file-01' })).resolves.toEqual({
      ok: false,
      error: 'binary type: refusing export',
      code: 'unsupported_type',
    });
  });

  it("carries success under the data key — the ADR's per-method named keys are the legacy shape", async () => {
    const result = await drive.search(docSearchArgsSchema.parse({ query: 'planning' }));
    expect(result.ok).toBe(true);
    expect('data' in result).toBe(true);
    expect('hits' in result).toBe(false);
  });

  it("'unsupported_type' does not fit the core envelope — the divergence stays doc-local", () => {
    // If core/error ever adopts the literal, this expectation fails typecheck and the
    // documented divergence resurfaces for an explicit decision.
    // @ts-expect-error core AdapterResult's code domain omits the doc-local literal
    const coreCoded: AdapterResult<DocReadResult> = { ok: false, error: 'binary', code: 'unsupported_type' };
    void coreCoded;
  });
});
