import { memoryImportSourceSchema, type ImportSource, type MemoryImportSource } from '@waldo/contracts';
import { APP_MEMORY_IMPORT_SOURCE_NAMES_V1 } from '../../../contracts/src/app/memory-import';

// A claim brought in from another assistant names it in its source_ref: import:<source>:<digest>:<conversation> for a chat
// export, where the digest is the uploaded file's own and the conversation is the export's own id, never content; and
// import:<source>:<digest>:doc for a summary the owner pasted, where the digest is the pasted text's. The same export or
// summary brought in again is the same import.
const PREFIX = 'import:';
export const IMPORT_SOURCE_NAMES: Readonly<Record<MemoryImportSource, string>> = APP_MEMORY_IMPORT_SOURCE_NAMES_V1;
export const importRef = (source: MemoryImportSource, digest: string, conversationId: string): string => `${PREFIX}${source}:${digest}:${conversationId}`;
export const DOC_IMPORT_PART = 'doc';
export const importSourceOf = (ref: string | null | undefined): MemoryImportSource | null => {
  if (!ref?.startsWith(PREFIX)) return null;
  const source = memoryImportSourceSchema.safeParse(ref.slice(PREFIX.length).split(':')[0]);
  return source.success ? source.data : null;
};
export const isDocImport = (ref: string | null | undefined): boolean => importSourceOf(ref) !== null && ref!.endsWith(`:${DOC_IMPORT_PART}`);

// An imported claim's evidence names where it came from, which is how the app shows that it was imported, and carries the
// quote. A forget reads the quote back from it, so it is barred and hidden with the claim's text.
const evidenceLead = (source: MemoryImportSource, doc: boolean) =>
  doc ? `the summary of the owner they pasted from ${IMPORT_SOURCE_NAMES[source]}: "` : `the owner in their ${IMPORT_SOURCE_NAMES[source]} export: "`;
export const importEvidence = (source: ImportSource, quote: string): string => `${evidenceLead(source, false)}${quote}"`;
export const docImportEvidence = (source: MemoryImportSource, quote: string): string => `${evidenceLead(source, true)}${quote}"`;
export const importedQuote = (claim: Readonly<{ source_ref?: string | null; evidence: string }>): string | null => {
  const source = importSourceOf(claim.source_ref);
  const lead = source && evidenceLead(source, isDocImport(claim.source_ref));
  if (!lead || !claim.evidence.startsWith(lead)) return null;
  // A confirm appends ` | confirmed: ...` after the closing quote mark; the quote itself may hold quote marks.
  const rest = claim.evidence.slice(lead.length), end = rest.indexOf('" | ');
  const quote = end !== -1 ? rest.slice(0, end) : rest.endsWith('"') ? rest.slice(0, -1) : '';
  return quote || null;
};
