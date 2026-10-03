import { describe, expect, it } from 'vitest';
import { Document, Packer, Paragraph } from 'docx';
import JSZip from 'jszip';

describe('DOCX Workers compatibility gate', () => {
  it('packs actual OOXML bytes with Unicode text using ArrayBuffer in workerd', async () => {
    const bytes = new Uint8Array(await Packer.toArrayBuffer(new Document({ sections: [{ children: [new Paragraph('नमस्ते 😀 café')] }] })));
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const zip = await JSZip.loadAsync(bytes);
    expect(await zip.file('word/document.xml')!.async('string')).toContain('नमस्ते 😀 café');
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    expect(zip.file('_rels/.rels')).not.toBeNull();
  });
});
