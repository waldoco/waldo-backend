import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import { renderMarkdownPdf } from './artifact-export';
import { WORKSPACE_TEXT_MAX_BYTES } from '@waldo/contracts';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export type DocumentRenderResult = { status: 'exported'; bytes: Uint8Array; mime: string } | { status: 'empty' | 'too_large' | 'unsupported_text' | 'render_failed' };
// Fixed inert document structure: text only, no model HTML, embedded files, or URL fetches.
export const renderWorkspaceDocument = async (text: string, format: 'pdf' | 'docx'): Promise<DocumentRenderResult> => {
  if (new TextEncoder().encode(text).byteLength > WORKSPACE_TEXT_MAX_BYTES) return { status: 'too_large' };
  if (!text.trim()) return { status: 'empty' };
  try {
    if (format === 'pdf') {
      const rendered = await renderMarkdownPdf(text);
      return rendered.status === 'exported' ? { status: 'exported', bytes: rendered.bytes, mime: rendered.mime_type } : rendered;
    }
    // OOXML requires XML 1.0 characters; rejecting forbidden controls preserves valid
    // Unicode instead of silently replacing text or producing a corrupt Word document.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text)) return { status: 'unsupported_text' };
    const children = text.replace(/\r/g, '').split('\n').map(line => {
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) return new Paragraph({ text: heading[2]!, heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][heading[1]!.length - 1]! });
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      return bullet ? new Paragraph({ text: bullet[1]!, bullet: { level: 0 } }) : new Paragraph({ text: line });
    });
    const bytes = new Uint8Array(await Packer.toArrayBuffer(new Document({ creator: 'Waldo', sections: [{ children }] })));
    return { status: 'exported', bytes, mime: DOCX_MIME };
  } catch { return { status: 'render_failed' }; }
};
