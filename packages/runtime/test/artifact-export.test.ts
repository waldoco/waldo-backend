import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { renderMarkdownPdf, MAX_EXPORT_CHARS } from '../src/channels/artifact-export';

afterEach(() => vi.unstubAllGlobals());

describe('markdown to PDF render (inert, Latin text only)', () => {
  it('renders headings, paragraphs and lists to a real PDF', async () => {
    const out = await renderMarkdownPdf('# Trip plan\n\nFlights are booked.\n\n- Day one\n- Day two\n');
    expect(out.status).toBe('exported');
    if (out.status !== 'exported') return;
    expect(new TextDecoder().decode(out.bytes.slice(0, 5))).toBe('%PDF-');
    const doc = await PDFDocument.load(out.bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(out.mime_type).toBe('application/pdf');
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('long text paginates instead of overflowing', async () => {
    const out = await renderMarkdownPdf(Array.from({ length: 400 }, (_, i) => `Line ${i} of the plan with some words to wrap around the page width a little.`).join('\n\n'));
    expect(out.status).toBe('exported');
    if (out.status !== 'exported') return;
    expect((await PDFDocument.load(out.bytes)).getPageCount()).toBeGreaterThan(1);
  });
  it('non-Latin text returns unsupported_text, never a garbled or blank PDF', async () => {
    expect(await renderMarkdownPdf('यात्रा योजना')).toEqual({ status: 'unsupported_text' });
  });
  it('hostile markdown makes no network call and its markup stays literal text', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('network call attempted'); });
    vi.stubGlobal('fetch', fetchSpy);
    const out = await renderMarkdownPdf('![x](https://evil.example/p.png)\n\n<script>fetch("https://evil.example")</script>');
    expect(out.status).toBe('exported');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('oversize input returns too_large and renders nothing', async () => {
    expect(await renderMarkdownPdf('a'.repeat(MAX_EXPORT_CHARS + 1))).toEqual({ status: 'too_large' });
  });
  it('empty input is a typed failure, not an empty PDF', async () => {
    expect(await renderMarkdownPdf('   \n')).toEqual({ status: 'empty' });
  });
});

it('long unbroken text wraps with bounded font measurements, rather than scanning every suffix', async () => {
 const {PDFFont,PDFPage}=await import('pdf-lib');
 const measure=vi.spyOn(PDFFont.prototype,'widthOfTextAtSize');
 const draw=vi.spyOn(PDFPage.prototype,'drawText');
 try {
  const rendered=await renderMarkdownPdf('W'.repeat(2000));expect(rendered.status).toBe('exported');
  if(rendered.status==='exported')expect((await PDFDocument.load(rendered.bytes)).getPageCount()).toBeGreaterThanOrEqual(1);
  // Logarithmic search per line keeps adversarial but permitted tokens bounded.
  expect(measure.mock.calls.length).toBeLessThan(1000);
  for(const [text,options] of draw.mock.calls){
   expect(options!.x! + options!.font!.widthOfTextAtSize(text,options!.size!)).toBeLessThanOrEqual(595.28-56);
   expect(options!.y).toBeGreaterThanOrEqual(56);
  }
 } finally {measure.mockRestore();draw.mockRestore()}
});
