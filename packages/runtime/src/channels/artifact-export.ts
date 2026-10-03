// Inert markdown -> PDF render for artifact export. Pure function: no network, no filesystem, no
// scripts. Only headings (#), bullets (-, *) and paragraphs are laid out; every other character
// is drawn as literal text. Built-in Helvetica covers Latin (WinAnsi) only, so any other script
// returns 'unsupported_text' rather than a garbled or blank PDF.
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';

export const MAX_EXPORT_CHARS = 200_000;
const PAGE = { width: 595.28, height: 841.89, margin: 56 };

export type RenderResult =
  | { readonly status: 'exported'; readonly bytes: Uint8Array; readonly mime_type: 'application/pdf'; readonly sha256: string }
  | { readonly status: 'unsupported_text' | 'too_large' | 'empty' };

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

const wrap = (text: string, font: PDFFont, size: number, width: number): string[] => {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let piece = word;
    // A single word wider than the line is broken by characters so nothing runs off the page.
    while (font.widthOfTextAtSize(piece, size) > width) {
      // Search the longest fitting prefix instead of remeasuring every character cut.
      // A permitted unbroken token must not trigger one measurement per character cut.
      let cut = 1;
      let high = piece.length - 1;
      while (cut < high) {
        const middle = Math.ceil((cut + high) / 2);
        if (font.widthOfTextAtSize(piece.slice(0, middle), size) <= width) cut = middle;
        else high = middle - 1;
      }
      if (line) { lines.push(line); line = ''; }
      lines.push(piece.slice(0, cut));
      piece = piece.slice(cut);
    }
    const next = line ? `${line} ${piece}` : piece;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else { lines.push(line); line = piece; }
  }
  if (line) lines.push(line);
  return lines;
};

export const renderMarkdownPdf = async (markdown: string): Promise<RenderResult> => {
  if (markdown.length > MAX_EXPORT_CHARS) return { status: 'too_large' };
  if (!markdown.trim()) return { status: 'empty' };
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // Probe once: encodeText throws for characters the built-in font cannot draw.
  try { regular.encodeText(markdown.replace(/[\r\n\t]/g, ' ')); } catch { return { status: 'unsupported_text' }; }
  let page = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.margin;
  const width = PAGE.width - PAGE.margin * 2;
  const draw = (text: string, font: PDFFont, size: number, indent: number, gap: number) => {
    for (const line of wrap(text, font, size, width - indent)) {
      if (y - size < PAGE.margin) { page = doc.addPage([PAGE.width, PAGE.height]); y = PAGE.height - PAGE.margin; }
      page.drawText(line, { x: PAGE.margin + indent, y: y - size, size, font });
      y -= size * 1.35;
    }
    y -= gap;
  };
  for (const raw of markdown.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim()) continue;
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) draw(heading[2]!, bold, heading[1]!.length === 1 ? 20 : heading[1]!.length === 2 ? 16 : 13, 0, 6);
    else if (bullet) draw(`- ${bullet[1]!}`, regular, 11, 14, 2);
    else draw(line.trim(), regular, 11, 0, 6);
  }
  const bytes = await doc.save();
  return { status: 'exported', bytes, mime_type: 'application/pdf', sha256: hex(await crypto.subtle.digest('SHA-256', bytes)) };
};
