// The text of the zipped Office formats, read in the Worker so either provider reads a Word, Excel or PowerPoint file the
// owner sends. The Word file is a real one written by the docx package; the others are built here part by part.
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import { describe, expect, it } from 'vitest';
import { OFFICE_TEXT_MAX_CHARS, OFFICE_TYPES, officeText } from '../src/channels/office-text';

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
// A zip of stored (uncompressed) parts: enough of the format for the reader, which inflates deflated parts the same way.
const zip = (parts: Readonly<Record<string, string>>): Uint8Array => {
  const local: number[] = [], central: number[] = [];
  const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff], u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  let count = 0;
  for (const [name, text] of Object.entries(parts)) {
    const nameBytes = [...new TextEncoder().encode(name)], data = new TextEncoder().encode(text), crc = crc32(data), offset = local.length;
    local.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...nameBytes);
    for (const byte of data) local.push(byte);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameBytes);
    count += 1;
  }
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(count), ...u16(count), ...u32(central.length), ...u32(local.length), ...u16(0)];
  const out = new Uint8Array(local.length + central.length + end.length);
  out.set(local); out.set(central, local.length); out.set(end, local.length + central.length);
  return out;
};

describe('officeText', () => {
  it('reads a real Word file\'s paragraphs and table cells, in order', async () => {
    const doc = new Document({ sections: [{ children: [
      new Paragraph({ children: [new TextRun('Lease renewal'), new TextRun({ text: ' for flat 4B', bold: true })] }),
      new Paragraph('Rent is due on the 5th & late fees apply after the 10th.'),
      new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('Deposit')] }), new TableCell({ children: [new Paragraph('2 months')] })] })] }),
    ] }] });
    const bytes = new Uint8Array(await (await Packer.toBlob(doc)).arrayBuffer());
    const text = await officeText(bytes, OFFICE_TYPES.docx);
    expect(text).toContain('Lease renewal for flat 4B\nRent is due on the 5th & late fees apply after the 10th.');
    expect(text).toMatch(/Deposit\n2 months/);
  });

  it('reads a workbook by sheet name, shared and inline strings, with each cell in its own column', async () => {
    const bytes = zip({
      'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Budget &amp; Plan" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Rent</t></si><si><r><t>Grocer</t></r><r><t xml:space="preserve">ies</t></r></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>1200</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>340.5</v></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Pay by Friday</t></is></c></row></sheetData></worksheet>',
    });
    expect(await officeText(bytes, OFFICE_TYPES.xlsx)).toBe('Sheet "Budget & Plan":\nRent\t\t1200\nGroceries\t340.5\n\nSheet "Notes":\nPay by Friday');
  });

  it('reads a deck slide by slide in slide order', async () => {
    const slide = (lines: string[]) => `<p:sld><p:cSld><p:spTree>${lines.map(line => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join('')}</p:spTree></p:cSld></p:sld>`;
    const bytes = zip({ 'ppt/slides/slide10.xml': slide(['Q4 wrap']), 'ppt/slides/slide2.xml': slide(['Plan', 'Hire two &lt;engineers&gt;']), 'ppt/slides/slide1.xml': slide(['Kickoff']) });
    expect(await officeText(bytes, OFFICE_TYPES.pptx)).toBe('Slide 1:\nKickoff\n\nSlide 2:\nPlan\nHire two <engineers>\n\nSlide 3:\nQ4 wrap');
  });

  it('says where a long text is cut, and reads nothing from a file that is not the office file it claims', async () => {
    const long = 'x'.repeat(OFFICE_TEXT_MAX_CHARS + 10);
    const text = await officeText(zip({ 'word/document.xml': `<w:document><w:body><w:p><w:r><w:t>${long}</w:t></w:r></w:p></w:body></w:document>` }), OFFICE_TYPES.docx);
    expect(text?.endsWith('10 of 200010 characters at the end are not shown, so say the end is missing.]')).toBe(true);
    expect(await officeText(zip({ 'notes.txt': 'hi' }), OFFICE_TYPES.docx)).toBeNull();
    expect(await officeText(new TextEncoder().encode('not a zip'), OFFICE_TYPES.xlsx)).toBeNull();
    expect(await officeText(zip({ 'word/document.xml': '<w:p/>' }), 'application/zip')).toBeNull();
  });
});
