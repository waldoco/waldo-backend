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
