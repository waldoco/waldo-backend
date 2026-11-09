import { b64url, buildMime, sha256Hex } from '../../src/connectors/google';
import { renderOwnerMail } from '../../src/channels/agent-mail/render';
import type { EmailSendProposal } from '../../src/channels/approvals';

type Draft = Omit<EmailSendProposal, 'raw' | 'digest'>;

// The bytes send_email freezes for a draft: base64url canonical MIME and their digest, signed when the draft names a
// signature and plain otherwise. `wire` builds the bytes from other words than the card shows, for a proposal whose
// bytes and fields disagree.
export const emailProposal = async (draft: Draft, wire: Partial<Pick<Draft, 'subject' | 'body' | 'to'>> = {}): Promise<EmailSendProposal> => {
  const { to, cc, bcc, subject, body, message_id, inReplyTo, references, signature } = { ...draft, ...wire };
  const threading = { ...(inReplyTo ? { inReplyTo } : {}), ...(references ? { references } : {}) };
  const signed = signature ? renderOwnerMail({ subject, body_markdown: body }, signature.first_name, { to, ...(cc ? { cc } : {}), ...(bcc ? { bcc } : {}) }, { messageId: message_id, ...threading }) : null;
  if (signed && !signed.ok) throw new Error(signed.code);
  const mime = signed?.ok ? signed.mime : buildMime({ to, ...(cc ? { cc } : {}), ...(bcc ? { bcc } : {}), subject, body, messageId: message_id, ...threading });
  const raw = b64url(new TextEncoder().encode(mime));
  return { ...draft, raw, digest: await sha256Hex(raw) };
};

// RFC 2045 quoted-printable back to text: soft line breaks dropped, =XX bytes decoded as UTF-8, CRLF read as LF.
const fromQuotedPrintable = (encoded: string) => {
  const out: number[] = [];
  const flat = encoded.replace(/=\r\n/g, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] === '=' && /^[0-9A-F]{2}$/.test(flat.slice(i + 1, i + 3))) { out.push(parseInt(flat.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(...new TextEncoder().encode(flat[i]!));
  }
  return new TextDecoder().decode(Uint8Array.from(out));
};

// The MIME text Gmail was handed: its header lines and its body, split where canonical MIME splits them. A signed
// (multipart) message's body is its decoded plain-text part, the words a plain-text client shows.
export const sentMime = (raw: string): Readonly<{ headers: readonly string[]; body: string; mime: string }> => {
  const binary = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
  const text = new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
  const split = text.indexOf('\r\n\r\n');
  const headers = text.slice(0, split).split('\r\n'), body = text.slice(split + 4);
  const boundary = /^Content-Type: multipart\/alternative; boundary="([^"]+)"$/.exec(headers.find(line => line.startsWith('Content-Type: multipart/')) ?? '')?.[1];
  if (!boundary) return { headers, body, mime: text };
  const plain = body.split(`--${boundary}`)[1]!;
  return { headers, body: fromQuotedPrintable(plain.slice(plain.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '')), mime: text };
};
