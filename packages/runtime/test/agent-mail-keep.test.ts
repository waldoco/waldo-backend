import { describe, expect, it, vi } from 'vitest';
import { mailForModel } from '../src/channels/agent-mail/turn';
import type { KeepFile } from '../src/channels/upload-keeper';

const CANARIES = ['0a1b2c3d4e5f6071', '1a2b3c4d5e6f7081', '2a3b4c5d6e7f8091'];
// A synthetic multipart mail: a PDF the model can read and a zip it cannot. Every value is fictional.
const raw = (boundary = 'b0') => new TextEncoder().encode([
  'From: Sender <sender@fixture.invalid>', 'To: owner@agent.fixture.invalid', 'Subject: Files', 'Message-ID: <m1@fixture.invalid>', 'MIME-Version: 1.0',
  `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain', '', 'Two files.', `--${boundary}`,
  'Content-Type: application/pdf; name="plan.pdf"', 'Content-Disposition: attachment; filename="plan.pdf"', 'Content-Transfer-Encoding: base64', '', btoa('%PDF-1.4 fixture'),
  `--${boundary}`, 'Content-Type: application/zip; name="bundle.zip"', 'Content-Disposition: attachment; filename="bundle.zip"', 'Content-Transfer-Encoding: base64', '', btoa('PK\x03\x04fixture'),
  `--${boundary}--`, ''].join('\r\n'));

describe('mail attachments with WALDO_FILE_TOOLS on', () => {
  it('keeps every attachment, keyed by the mail row, and names where each went', async () => {
    const kept: KeepFile[] = [];
    const keep = vi.fn(async (file: KeepFile) => { kept.push(file); return { status: 'saved' as const, path: `mail/f/${file.filename}`, file_id: `id-${kept.length}`, revision: 1 }; });
    const mail = await mailForModel(raw(), { id: 'row-1', basis: 'owner_from' }, 'owner@agent.fixture.invalid', CANARIES, keep);
    expect(kept.map(file => [file.filename, file.key])).toEqual([['plan.pdf', 'mail:row-1:0'], ['bundle.zip', 'mail:row-1:1']]);
    expect(mail.attachments.map(file => file.filename)).toEqual(['plan.pdf']);
    expect(mail.text).toContain('bundle.zip (application/zip)');
    expect(mail.text).not.toContain('a type Waldo cannot read');
    expect(mail.text).toContain('"saved_to_workspace":["plan.pdf: mail/f/plan.pdf (file_id id-1, revision 1)","bundle.zip: mail/f/bundle.zip (file_id id-2, revision 1)"]');
  });

  it('a mail the scribe withholds keeps nothing', async () => {
    const keep = vi.fn();
    const withheld = new TextDecoder().decode(raw()).replace('Subject: Files', `Subject: ${CANARIES[0]}`);
    const mail = await mailForModel(new TextEncoder().encode(withheld), { id: 'row-2', basis: 'owner_from' }, 'owner@agent.fixture.invalid', CANARIES, keep);
    expect(mail.text).toMatch(/^\[This mail was withheld/);
    expect(keep).not.toHaveBeenCalled();
  });

  it('a part the mail shows inline (a signature logo) is not kept', async () => {
    const inline = new TextDecoder().decode(raw()).replace('Content-Disposition: attachment; filename="bundle.zip"', 'Content-Disposition: inline; filename="logo.zip"');
    const kept: KeepFile[] = [];
    await mailForModel(new TextEncoder().encode(inline), { id: 'row-3', basis: 'owner_from' }, 'owner@agent.fixture.invalid', CANARIES, async file => { kept.push(file); return { status: 'saved', path: 'mail/f/x', file_id: 'id', revision: 1 }; });
    expect(kept.map(file => file.filename)).toEqual(['plan.pdf']);
  });

  it('without a keeper it is unchanged: the zip is a type Waldo cannot read', async () => {
    const mail = await mailForModel(raw(), { id: 'row-1', basis: 'owner_from' }, 'owner@agent.fixture.invalid', CANARIES);
    expect(mail.text).toContain('bundle.zip (application/zip, a type Waldo cannot read)');
    expect(mail.text).not.toContain('saved_to_workspace');
  });
});

describe('mail attachments a name alone would not open', () => {
  it('opens a scan sent as a generic type with no extension, and a photo typed image/jpg, by what they are', async () => {
    const mail = await mailForModel(new TextEncoder().encode([
      'From: Sender <sender@fixture.invalid>', 'To: owner@agent.fixture.invalid', 'Subject: Scans', 'Message-ID: <m2@fixture.invalid>', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"', '', '--b1', 'Content-Type: text/plain', '', 'Two scans.', '--b1',
      'Content-Type: application/octet-stream; name="Scan 0042"', 'Content-Disposition: attachment; filename="Scan 0042"', 'Content-Transfer-Encoding: base64', '', btoa('%PDF-1.7\n%\xe2\xe3\xcf\xd3'),
      '--b1', 'Content-Type: image/jpg; name="receipt.jpg"', 'Content-Disposition: attachment; filename="receipt.jpg"', 'Content-Transfer-Encoding: base64', '', btoa('\xff\xd8\xff\xe0\x00\x10JFIF'),
      '--b1--', ''].join('\r\n')), { id: 'row-4', basis: 'owner_from' }, 'owner@agent.fixture.invalid', CANARIES);
    expect(mail.attachments.map(({ kind, mime_type, filename }) => ({ kind, mime_type, filename }))).toEqual([
      { kind: 'file', mime_type: 'application/pdf', filename: 'Scan 0042.pdf' }, { kind: 'image', mime_type: 'image/jpeg', filename: 'receipt.jpg' }]);
    expect(mail.text).toContain('"attached_not_opened":[]');
  });
});

describe('an office file mailed to the Waldo address', () => {
  it('reaches the model as its text', async () => {
    const { Document, Packer, Paragraph } = await import('docx');
    const docx = new Uint8Array(await (await Packer.toBlob(new Document({ sections: [{ children: [new Paragraph('Invoice 118: due 30 Nov.')] }] }))).arrayBuffer());
    let binary = ''; for (const byte of docx) binary += String.fromCharCode(byte);
    const mail = await mailForModel(new TextEncoder().encode([
      'From: Sender <sender@fixture.invalid>', 'To: owner@agent.fixture.invalid', 'Subject: Invoice', 'Message-ID: <m3@fixture.invalid>', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b2"', '', '--b2', 'Content-Type: text/plain', '', 'Attached.', '--b2',
      'Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document; name="invoice.docx"', 'Content-Disposition: attachment; filename="invoice.docx"',
      'Content-Transfer-Encoding: base64', '', btoa(binary), '--b2--', ''].join('\r\n')), { id: 'row-5', basis: 'owner_from' }, 'owner@agent.fixture.invalid', CANARIES);
    expect(mail.attachments).toEqual([{ kind: 'file', mime_type: 'text/plain', filename: 'invoice.docx.txt', data_base64: btoa('Invoice 118: due 30 Nov.') }]);
  });
});
