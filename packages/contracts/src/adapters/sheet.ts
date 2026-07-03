import { z } from 'zod';
import type { AdapterResult } from '../core/error';
import { errorCodeSchema, iso8601Schema } from '../core/error';

export const sheetProviderNameSchema = z.enum(['google_sheets', 'excel_graph']);
export type SheetProviderName = z.infer<typeof sheetProviderNameSchema>;

// sha256 hex of (user_id + sheet_id + range + serialised_value + 5-min bucket) per ADR-0026.
// Lowercase-only pins one canonical representation per digest.
export const commitHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

// ADR-0026 idempotency tunables: the 5-min bucket feeding the commit_hash formula and the
// 24h dedup window the provider's sheet_commits LRU honours (a repeated commit_hash inside
// the window returns ok without a second provider write). Typed here so the values are
// tunable without re-ADR.
export const sheetCommitPolicySchema = z.strictObject({
  hash_bucket_minutes: z.int().positive(),
  dedup_window_hours: z.int().positive(),
});
export type SheetCommitPolicy = z.infer<typeof sheetCommitPolicySchema>;

export const SHEET_COMMIT_POLICY: SheetCommitPolicy = {
  hash_bucket_minutes: 5,
  dedup_window_hours: 24,
};

// Closed six-variant union (ADR-0026). Formulas stay strings — the adapter never evaluates
// them; the provider does. 'empty' carries no value key, and text values are non-empty, so
// an empty cell has exactly one representation.
export const cellValueSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('string'), value: z.string().min(1) }),
  z.strictObject({ type: z.literal('number'), value: z.number() }),
  z.strictObject({ type: z.literal('boolean'), value: z.boolean() }),
  z.strictObject({ type: z.literal('date'), value: iso8601Schema }),
  z.strictObject({ type: z.literal('formula'), value: z.string().min(1) }),
  z.strictObject({ type: z.literal('empty') }),
]);
export type CellValue = z.infer<typeof cellValueSchema>;

// range is A1 notation — the canonical syntax across both providers (ADR-0026); adapters
// translate provider-side.
export const cellSchema = z.strictObject({
  range: z.string().min(1),
  value: cellValueSchema,
  format: z
    .strictObject({
      bold: z.boolean().optional(),
      color: z.string().min(1).optional(),
      number_format: z.string().min(1).optional(),
    })
    .optional(),
});
export type Cell = z.infer<typeof cellSchema>;

export const readRangeArgsSchema = z.strictObject({
  sheet_id: z.string().min(1),
  range: z.string().min(1),
});
export type ReadRangeArgs = z.infer<typeof readRangeArgsSchema>;

export const writeCellArgsSchema = z.strictObject({
  sheet_id: z.string().min(1),
  // Single cell, e.g. "Sheet1!B5" — single-cell-ness is enforced provider-side because A1
  // sheet-name quoting makes it undecidable by regex.
  range: z.string().min(1),
  value: cellValueSchema,
  commit_hash: commitHashSchema,
  expected_current_value: cellValueSchema.optional(),
});
export type WriteCellArgs = z.infer<typeof writeCellArgsSchema>;

export const appendRowArgsSchema = z.strictObject({
  sheet_id: z.string().min(1),
  sheet_name: z.string().min(1),
  values: z.array(cellValueSchema).min(1),
  commit_hash: commitHashSchema,
});
export type AppendRowArgs = z.infer<typeof appendRowArgsSchema>;

export const listSheetsArgsSchema = z.strictObject({});
export type ListSheetsArgs = z.infer<typeof listSheetsArgsSchema>;

export const listTabsArgsSchema = z.strictObject({ sheet_id: z.string().min(1) });
export type ListTabsArgs = z.infer<typeof listTabsArgsSchema>;

export const sheetUndoArgsSchema = z.strictObject({ commit_hash: commitHashSchema });
export type SheetUndoArgs = z.infer<typeof sheetUndoArgsSchema>;

export const readRangeDataSchema = z.strictObject({ cells: z.array(cellSchema) });
export type ReadRangeData = z.infer<typeof readRangeDataSchema>;

// write_cell and undo succeed with no payload; the empty strict object keeps AdapterResult's
// required data key uniform without minting fields ADR-0026 does not define.
export const sheetAckSchema = z.strictObject({});
export type SheetAck = z.infer<typeof sheetAckSchema>;

export const appendRowDataSchema = z.strictObject({ row_index: z.int().nonnegative() });
export type AppendRowData = z.infer<typeof appendRowDataSchema>;

export const listSheetsDataSchema = z.strictObject({
  sheets: z.array(
    z.strictObject({ id: z.string().min(1), name: z.string().min(1), url: z.url() }),
  ),
});
export type ListSheetsData = z.infer<typeof listSheetsDataSchema>;

export const listTabsDataSchema = z.strictObject({
  tabs: z.array(z.strictObject({ name: z.string().min(1), gid: z.int().nonnegative() })),
});
export type ListTabsData = z.infer<typeof listTabsDataSchema>;

// Runtime validator for the AdapterResult envelope around each method's payload. Module-local:
// core/error keeps AdapterResult a static type by design (a generic schema is a factory, not a
// value); the concrete per-method schemas below are the runtime-boundary validators.
const adapterResult = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), data }),
    z.strictObject({ ok: z.literal(false), error: z.string().min(1), code: errorCodeSchema }),
  ]);

export const readRangeResultSchema = adapterResult(readRangeDataSchema);
export const writeCellResultSchema = adapterResult(sheetAckSchema);
export const appendRowResultSchema = adapterResult(appendRowDataSchema);
export const listSheetsResultSchema = adapterResult(listSheetsDataSchema);
export const listTabsResultSchema = adapterResult(listTabsDataSchema);
export const sheetUndoResultSchema = adapterResult(sheetAckSchema);

// The SheetProvider seam (ADR-0026). Both mutating methods carry a commit_hash and
// always-confirm per the ADR-0018 connector_write rule — the tool layer proposes a card
// first and this interface fires only after the explicit confirmation signal, at every
// autonomy level. read_range is unrestricted (read-only, no side effects); cell values pass
// Scribe (ADR-0024) both directions because they may carry PII. The Excel
// '{drive_id}!{item_id}' composite hides behind the opaque sheet_id string.
export interface SheetProvider {
  provider: SheetProviderName;
  read_range(args: ReadRangeArgs): Promise<AdapterResult<ReadRangeData>>;
  write_cell(args: WriteCellArgs): Promise<AdapterResult<SheetAck>>;
  append_row(args: AppendRowArgs): Promise<AdapterResult<AppendRowData>>;
  list_sheets(args: ListSheetsArgs): Promise<AdapterResult<ListSheetsData>>;
  list_tabs(args: ListTabsArgs): Promise<AdapterResult<ListTabsData>>;
  // Reversibility edge (ADR-0026): restores the previous value only while no concurrent
  // write has been observed; refusal surfaces as a coded failure, never a throw.
  undo(args: SheetUndoArgs): Promise<AdapterResult<SheetAck>>;
}
