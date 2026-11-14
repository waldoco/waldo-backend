import { ArchiveError, inflateEntry, readZipDirectory, type ArchiveEntry } from '@waldo/workspace';

// The text of a Word, Excel or PowerPoint file (the zipped XML formats), read in the Worker so the model reads it on either
// provider: Claude's Messages API has no block for office files, and OpenAI's file input reads them only by its own
// extraction. Text only: no layout, images or formulas, which the note to the model says.
export const OFFICE_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;
const OFFICE_KIND = new Map<string, keyof typeof OFFICE_TYPES>(Object.entries(OFFICE_TYPES).map(([kind, mime]) => [mime, kind as keyof typeof OFFICE_TYPES]));
export const isOfficeType = (mime: string): boolean => OFFICE_KIND.has(mime);

// Bounds on the work one file may cost: the XML inflated across all its parts, and the text handed on. A longer text is cut,
// and the cut is said in the text itself so the model tells the owner the rest is missing.
const XML_BUDGET_BYTES = 40 * 1024 * 1024;
export const OFFICE_TEXT_MAX_CHARS = 200_000;
const PARTS_MAX = 200;

const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodeXml = (text: string): string => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  }
  return ENTITIES[name] ?? whole;
});
const utf8 = new TextDecoder('utf-8');
// The runs of one paragraph: text elements in order, with tabs and line breaks where the XML marks them.
const runs = (xml: string, text: string): string => [...xml.matchAll(new RegExp(`<${text}(?:\\s[^>]*)?>([^<]*)</${text}>|<(?:w|a):(tab|br)\\b[^>]*/>`, 'g'))]
  .map(match => match[2] === 'tab' ? '\t' : match[2] === 'br' ? '\n' : decodeXml(match[1] ?? '')).join('');
const paragraphs = (xml: string, paragraph: string, text: string): string[] =>
  [...xml.matchAll(new RegExp(`<${paragraph}[\\s>][\\s\\S]*?</${paragraph}>`, 'g'))].map(match => runs(match[0], text));
const columnOf = (letters: string | undefined): number | null => letters ? [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1 : null;
const partNumber = (name: string): number => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

const docxText = (read: (name: string) => Promise<string | null>) => async (): Promise<string | null> => {
  const body = await read('word/document.xml');
  return body === null ? null : paragraphs(body, 'w:p', 'w:t').join('\n');
};

const pptxText = (read: (name: string) => Promise<string | null>, names: readonly string[]) => async (): Promise<string | null> => {
  const slides = names.filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => partNumber(a) - partNumber(b));
  if (!slides.length) return null;
  const out: string[] = [];
  for (const [index, name] of slides.entries()) {
    const xml = await read(name);
    if (xml !== null) out.push(`Slide ${index + 1}:\n${paragraphs(xml, 'a:p', 'a:t').filter(Boolean).join('\n')}`);
  }
  return out.join('\n\n');
};

const xlsxText = (read: (name: string) => Promise<string | null>, names: readonly string[]) => async (): Promise<string | null> => {
  const shared = [...((await read('xl/sharedStrings.xml')) ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match => runs(match[1]!, 't'));
  // Sheet names in the workbook's order, joined to their parts through the workbook's relationships.
  const workbook = (await read('xl/workbook.xml')) ?? '';
  const rels = (await read('xl/_rels/workbook.xml.rels')) ?? '';
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(match => [/\bId="([^"]+)"/.exec(match[0])?.[1] ?? '', /\bTarget="([^"]+)"/.exec(match[0])?.[1] ?? '']));
  const named = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(match => ({
    name: decodeXml(/\bname="([^"]*)"/.exec(match[0])?.[1] ?? ''),
    part: `xl/${(targets.get(/\br:id="([^"]+)"/.exec(match[0])?.[1] ?? '') ?? '').replace(/^\/?xl\//, '')}`,
  })).filter(sheet => names.includes(sheet.part));
  const sheets = named.length ? named : names.filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort((a, b) => partNumber(a) - partNumber(b)).map((part, index) => ({ name: `Sheet ${index + 1}`, part }));
  if (!sheets.length) return null;
  const out: string[] = [];
  for (const sheet of sheets) {
    const xml = await read(sheet.part);
    if (xml === null) continue;
    const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row => {
      // Each cell goes in its own column, so an empty cell the XML leaves out does not shift the ones after it.
      const cells: string[] = [];
      for (const cell of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1] ?? '', inner = cell[2] ?? '', type = /\bt="([^"]+)"/.exec(attributes)?.[1];
        const value = type === 'inlineStr' ? runs(inner, 't') : decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
        const column = columnOf(/\br="([A-Z]+)\d+"/.exec(attributes)?.[1]) ?? cells.length;
        if (column < 1024) cells[column] = type === 's' ? shared[Number(value)] ?? '' : value;
      }
      return Array.from(cells, cell => cell ?? '').join('\t').replace(/\t+$/, '');
    }).filter(Boolean);
    out.push(`Sheet "${sheet.name}":\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
};

// The file's text, or null when it is not a readable office file of that type (damaged, encrypted, or another zip).
export const officeText = async (bytes: Uint8Array, mime: string): Promise<string | null> => {
  const kind = OFFICE_KIND.get(mime);
  if (!kind) return null;
  let entries: readonly ArchiveEntry[];
  try { entries = readZipDirectory(bytes); } catch (error) { if (error instanceof ArchiveError) return null; throw error; }
  const byName = new Map(entries.filter(entry => entry.kind === 'file').slice(0, 2000).map(entry => [entry.name, entry]));
  let budget = XML_BUDGET_BYTES, parts = 0;
  const read = async (name: string): Promise<string | null> => {
    const entry = byName.get(name);
    if (!entry || parts >= PARTS_MAX || entry.size > budget) return null;
    parts += 1;
    try {
      const xml = await inflateEntry(bytes, entry, budget);
      budget -= xml.length;
      return utf8.decode(xml);
    } catch { return null; }
  };
  const names = [...byName.keys()];
  const text = await (kind === 'docx' ? docxText(read) : kind === 'pptx' ? pptxText(read, names) : xlsxText(read, names))();
  if (text === null) return null;
  const trimmed = text.replace(/\n{3,}/g, '\n\n').trim();
  return trimmed.length > OFFICE_TEXT_MAX_CHARS
    ? `${trimmed.slice(0, OFFICE_TEXT_MAX_CHARS)}\n\n[The file's text is longer than Waldo reads at once: ${trimmed.length - OFFICE_TEXT_MAX_CHARS} of ${trimmed.length} characters at the end are not shown, so say the end is missing.]`
    : trimmed;
};
