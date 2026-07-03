// Owning ADR: ADR-0026 (SheetProvider contract); the ADR-0018 connector_write always-confirm
// rule rides every mutating method.
// Invariants under test: the two-provider name tuple; the closed six-variant CellValue union
// ('empty' carries no value key); commit_hash required on both mutating methods; the optional
// optimistic-concurrency field; ADR-pinned idempotency tunables; every runtime boundary
// parses as the AdapterResult envelope from core/error with success under the data key.
// Failure modes caught: a provider or cell-variant literal added/removed/reordered silently,
// a write path that drops its idempotency hash, envelope drift (success without data, error
// without a coded cause, a code outside the seven-literal union), and policy-constant drift
// from the ADR-pinned 5-min bucket / 24h window. The repeated-commit_hash-within-24h golden
// (no second provider write) is runtime behaviour and lives with the DO implementation.
import { describe, expect, it } from 'vitest';
import type { AdapterResult } from '../core/error';
import type { ReadRangeData, SheetProvider, WriteCellArgs } from './sheet';
import {
  appendRowArgsSchema,
  appendRowResultSchema,
  cellSchema,
  cellValueSchema,
  commitHashSchema,
  listSheetsDataSchema,
  listSheetsResultSchema,
  listTabsResultSchema,
  readRangeResultSchema,
  SHEET_COMMIT_POLICY,
  sheetCommitPolicySchema,
  sheetProviderNameSchema,
  sheetUndoArgsSchema,
  writeCellArgsSchema,
  writeCellResultSchema,
} from './sheet';

const hash = 'a'.repeat(64);

const baseCell = { range: 'Sheet1!B5', value: { type: 'number', value: 14 } };

const baseWrite = {
  sheet_id: 'sheet-1',
  range: 'Sheet1!B5',
  value: { type: 'number', value: 14 },
  commit_hash: hash,
};

const baseAppend = {
  sheet_id: 'sheet-1',
  sheet_name: 'Sheet1',
  values: [{ type: 'string', value: 'standup' }, { type: 'number', value: 14 }],
  commit_hash: hash,
};

describe('sheetProviderName', () => {
  it('is exactly the two providers, in order', () => {
    expect(sheetProviderNameSchema.options).toEqual(['google_sheets', 'excel_graph']);
  });

  it('rejects an unknown provider', () => {
    expect(sheetProviderNameSchema.safeParse('airtable').success).toBe(false);
  });
});

describe('cellValue', () => {
  it('is exactly the six variants, in order', () => {
    expect(cellValueSchema.options.map((o) => o.shape.type.value)).toEqual([
      'string',
      'number',
      'boolean',
      'date',
      'formula',
      'empty',
    ]);
  });

  it('accepts every variant; a formula stays a string, unevaluated', () => {
    expect(cellValueSchema.safeParse({ type: 'string', value: 'headcount' }).success).toBe(true);
    expect(cellValueSchema.safeParse({ type: 'number', value: 14 }).success).toBe(true);
    expect(cellValueSchema.safeParse({ type: 'boolean', value: false }).success).toBe(true);
    expect(cellValueSchema.safeParse({ type: 'date', value: '2026-05-23T09:00:00Z' }).success).toBe(
      true,
    );
    expect(cellValueSchema.parse({ type: 'formula', value: '=SUM(A1:A10)' })).toEqual({
      type: 'formula',
      value: '=SUM(A1:A10)',
    });
    expect(cellValueSchema.safeParse({ type: 'empty' }).success).toBe(true);
  });

  it('rejects a number variant carrying a string value', () => {
    expect(cellValueSchema.safeParse({ type: 'number', value: 'twelve' }).success).toBe(false);
  });

  it('rejects an empty variant carrying a value key (extra key on strictObject)', () => {
    expect(cellValueSchema.safeParse({ type: 'empty', value: null }).success).toBe(false);
  });

  it('rejects a seventh variant', () => {
    expect(cellValueSchema.safeParse({ type: 'currency', value: 12 }).success).toBe(false);
  });

  it('rejects a date variant with a non-ISO8601 value', () => {
    expect(cellValueSchema.safeParse({ type: 'date', value: 'yesterday' }).success).toBe(false);
  });

  it('rejects an empty-string text value — empty text is the empty variant', () => {
    expect(cellValueSchema.safeParse({ type: 'string', value: '' }).success).toBe(false);
  });
});

describe('cell', () => {
  it('accepts a cell with and without formatting metadata', () => {
    expect(cellSchema.safeParse(baseCell).success).toBe(true);
    expect(
      cellSchema.safeParse({ ...baseCell, format: { bold: true, number_format: '0.00' } }).success,
    ).toBe(true);
  });

  it('rejects an unknown format key', () => {
    expect(cellSchema.safeParse({ ...baseCell, format: { italic: true } }).success).toBe(false);
  });

  it('rejects an extra field on the cell (strictObject drift)', () => {
    expect(cellSchema.safeParse({ ...baseCell, note: 'x' }).success).toBe(false);
  });
});

describe('commitHash', () => {
  it('accepts a 64-char lower-hex digest; rejects upper-hex and short digests', () => {
    expect(commitHashSchema.safeParse(hash).success).toBe(true);
    expect(commitHashSchema.safeParse(hash.toUpperCase()).success).toBe(false);
    expect(commitHashSchema.safeParse('a'.repeat(63)).success).toBe(false);
  });
});

describe('writeCellArgs', () => {
  it('accepts a write, with and without the optimistic-concurrency expected_current_value', () => {
    expect(writeCellArgsSchema.safeParse(baseWrite).success).toBe(true);
    expect(
      writeCellArgsSchema.safeParse({
        ...baseWrite,
        expected_current_value: { type: 'number', value: 12 },
      }).success,
    ).toBe(true);
  });

  it('rejects a write missing commit_hash — an unhashed external mutation is contract drift', () => {
    const unhashed: Record<string, unknown> = { ...baseWrite };
    delete unhashed['commit_hash'];
    expect(writeCellArgsSchema.safeParse(unhashed).success).toBe(false);
    // @ts-expect-error commit_hash is required on every mutating call (ADR-0026 idempotency)
    const bad: WriteCellArgs = { sheet_id: 'sheet-1', range: 'Sheet1!B5', value: { type: 'empty' } };
    void bad;
  });
});

describe('appendRowArgs', () => {
  it('accepts a row of typed values', () => {
    expect(appendRowArgsSchema.safeParse(baseAppend).success).toBe(true);
  });

  it('rejects an append missing sheet_name', () => {
    const nameless: Record<string, unknown> = { ...baseAppend };
    delete nameless['sheet_name'];
    expect(appendRowArgsSchema.safeParse(nameless).success).toBe(false);
  });

  it('rejects an append missing commit_hash', () => {
    const unhashed: Record<string, unknown> = { ...baseAppend };
    delete unhashed['commit_hash'];
    expect(appendRowArgsSchema.safeParse(unhashed).success).toBe(false);
  });

  it('rejects an empty values row', () => {
    expect(appendRowArgsSchema.safeParse({ ...baseAppend, values: [] }).success).toBe(false);
  });
});

describe('sheetUndoArgs', () => {
  it('accepts the commit_hash of the write to reverse and nothing else', () => {
    expect(sheetUndoArgsSchema.safeParse({ commit_hash: hash }).success).toBe(true);
    expect(sheetUndoArgsSchema.safeParse({ commit_hash: hash, force: true }).success).toBe(false);
  });
});

describe('SHEET_COMMIT_POLICY', () => {
  it('pins the ADR values: 5-min hash bucket, 24h dedup window', () => {
    expect(sheetCommitPolicySchema.safeParse(SHEET_COMMIT_POLICY).success).toBe(true);
    expect(SHEET_COMMIT_POLICY.hash_bucket_minutes).toBe(5);
    expect(SHEET_COMMIT_POLICY.dedup_window_hours).toBe(24);
  });
});

describe('adapter results — envelope conformance', () => {
  it('read_range success parses and is the AdapterResult shape from core/error', () => {
    const result = readRangeResultSchema.parse({ ok: true, data: { cells: [baseCell] } });
    // Statically pins the envelope: renaming the data key breaks this assignment.
    const typed: AdapterResult<ReadRangeData> = result;
    expect(typed.ok).toBe(true);
  });

  it('a coded failure parses; success without data does not', () => {
    expect(
      writeCellResultSchema.safeParse({
        ok: false,
        error: 'sheet not shared with Waldo',
        code: 'forbidden',
      }).success,
    ).toBe(true);
    expect(writeCellResultSchema.safeParse({ ok: true }).success).toBe(false);
  });

  it('rejects an error without a code and a code outside the seven-literal union', () => {
    expect(writeCellResultSchema.safeParse({ ok: false, error: 'x' }).success).toBe(false);
    // 'unsupported_type' is doc-adapter-local vocabulary; it must not leak into sheet results.
    expect(
      writeCellResultSchema.safeParse({ ok: false, error: 'x', code: 'unsupported_type' }).success,
    ).toBe(false);
  });

  it('write_cell success carries the empty ack payload — no minted fields', () => {
    expect(writeCellResultSchema.safeParse({ ok: true, data: {} }).success).toBe(true);
    expect(writeCellResultSchema.safeParse({ ok: true, data: { row_index: 0 } }).success).toBe(
      false,
    );
  });

  it('append_row success returns the appended row index', () => {
    expect(appendRowResultSchema.safeParse({ ok: true, data: { row_index: 7 } }).success).toBe(
      true,
    );
    expect(appendRowResultSchema.safeParse({ ok: true, data: { row_index: -1 } }).success).toBe(
      false,
    );
  });

  it('list_sheets and list_tabs payloads parse; a non-url sheet link is rejected', () => {
    expect(
      listSheetsResultSchema.safeParse({
        ok: true,
        data: {
          sheets: [
            { id: 's1', name: 'Q3 Planning', url: 'https://docs.google.com/spreadsheets/d/s1' },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      listSheetsDataSchema.safeParse({ sheets: [{ id: 's1', name: 'Q3', url: 'not-a-url' }] })
        .success,
    ).toBe(false);
    expect(
      listTabsResultSchema.safeParse({ ok: true, data: { tabs: [{ name: 'Sheet1', gid: 0 }] } })
        .success,
    ).toBe(true);
  });
});

describe('SheetProvider seam — fake provider', () => {
  it('is satisfiable by a pure fake that resolves coded failures instead of throwing', async () => {
    const provider: SheetProvider = {
      provider: 'google_sheets',
      read_range: async () => ({ ok: true, data: { cells: [] } }),
      write_cell: async () => ({
        ok: false,
        error: 'unconfirmed write refused',
        code: 'invalid_args',
      }),
      append_row: async () => ({ ok: true, data: { row_index: 0 } }),
      list_sheets: async () => ({ ok: true, data: { sheets: [] } }),
      list_tabs: async () => ({ ok: true, data: { tabs: [] } }),
      undo: async () => ({ ok: true, data: {} }),
    };
    await expect(
      provider.write_cell({
        sheet_id: 'sheet-1',
        range: 'Sheet1!B5',
        value: { type: 'empty' },
        commit_hash: hash,
      }),
    ).resolves.toEqual({ ok: false, error: 'unconfirmed write refused', code: 'invalid_args' });
    await expect(provider.undo({ commit_hash: hash })).resolves.toEqual({ ok: true, data: {} });
  });
});
