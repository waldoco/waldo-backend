import { IMPORT_SOURCES, type ImportSource } from '@waldo/contracts';

// A claim brought in from another assistant's chat export names it in its source_ref: import:<source>:<digest>:<conversation>.
// The digest is the uploaded file's own, so the same export uploaded again is the same import; the conversation is the
// export's own id, never content.
const PREFIX = 'import:';
export const IMPORT_SOURCE_NAMES: Readonly<Record<ImportSource, string>> = { chatgpt: 'ChatGPT', claude: 'Claude' };
export const importRef = (source: ImportSource, digest: string, conversationId: string): string => `${PREFIX}${source}:${digest}:${conversationId}`;
export const importSourceOf = (ref: string | null | undefined): ImportSource | null => {
  if (!ref?.startsWith(PREFIX)) return null;
  const source = ref.slice(PREFIX.length).split(':')[0];
  return (IMPORT_SOURCES as readonly string[]).includes(source ?? '') ? source as ImportSource : null;
};

// An imported claim's evidence names the export, which is how the app shows that it was imported, and carries the owner's
// quote. A forget reads the quote back from it, so it is barred and hidden with the claim's text.
const evidenceLead = (source: ImportSource) => `the owner in their ${IMPORT_SOURCE_NAMES[source]} export: "`;
export const importEvidence = (source: ImportSource, quote: string): string => `${evidenceLead(source)}${quote}"`;
export const importedQuote = (claim: Readonly<{ source_ref?: string | null; evidence: string }>): string | null => {
  const source = importSourceOf(claim.source_ref);
  const lead = source && evidenceLead(source);
  if (!lead || !claim.evidence.startsWith(lead)) return null;
  // A confirm appends ` | confirmed: ...` after the closing quote mark; the quote itself may hold quote marks.
  const rest = claim.evidence.slice(lead.length), end = rest.indexOf('" | ');
  const quote = end !== -1 ? rest.slice(0, end) : rest.endsWith('"') ? rest.slice(0, -1) : '';
  return quote || null;
};
